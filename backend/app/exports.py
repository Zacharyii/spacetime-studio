from __future__ import annotations

import asyncio
import re
import shutil
import struct
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from .processing import ROOT, TMP


OUTPUTS = ROOT / "outputs"
MAX_EXPORT_FRAMES = 300
MAX_FRAME_BYTES = 30 * 1024 * 1024
ALLOWED_SIZES = {(1080, 1920), (1920, 1080), (720, 1280), (1280, 720)}


@dataclass
class ExportJob:
    export_id: str
    session_id: str
    width: int
    height: int
    fps: int
    frame_count: int
    folder: Path
    output_path: Path
    next_frame: int = 0
    status: str = "receiving"
    progress: float = 0
    error: str = ""
    process: asyncio.subprocess.Process | None = None
    task: asyncio.Task | None = field(default=None, repr=False)


JOBS: dict[str, ExportJob] = {}


def cleanup_abandoned_export_frames() -> None:
    folder = TMP / "exports"
    if not folder.is_dir():
        return
    for child in folder.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)


def create_export(session_id: str, frame_count: int, width: int, height: int, fps: int,
                  output_name: str | None = None) -> ExportJob:
    if not session_id.isalnum() or len(session_id) != 32 or not (TMP / session_id / "source.mp4").is_file() and not any((TMP / session_id).glob("source.*")):
        raise ValueError("素材会话无效，请重新上传视频。")
    if frame_count < 1 or frame_count > MAX_EXPORT_FRAMES:
        raise ValueError(f"导出帧数必须在 1～{MAX_EXPORT_FRAMES} 之间。")
    if (width, height) not in ALLOWED_SIZES or fps != 30:
        raise ValueError("当前只支持 720P 或 1080P、30 FPS 的 9:16 / 16:9 导出。")

    OUTPUTS.mkdir(exist_ok=True)
    export_id = uuid.uuid4().hex
    folder = TMP / "exports" / export_id
    folder.mkdir(parents=True, exist_ok=False)
    stem = Path(output_name or "space-time").stem
    stem = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", stem, flags=re.UNICODE).strip("-_")[:48] or "space-time"
    output_path = OUTPUTS / f"{stem}-{export_id[:8]}.mp4"
    job = ExportJob(export_id, session_id, width, height, fps, frame_count, folder, output_path)
    JOBS[export_id] = job
    return job


def get_export(export_id: str) -> ExportJob | None:
    if not export_id.isalnum() or len(export_id) != 32:
        return None
    return JOBS.get(export_id)


async def append_frames(job: ExportJob, start_index: int, files) -> int:
    if job.status != "receiving":
        raise ValueError("导出任务当前不接收图像帧。")
    if start_index != job.next_frame:
        raise ValueError("导出帧顺序异常，请重新开始导出。")
    if not files or len(files) > 5 or start_index + len(files) > job.frame_count:
        raise ValueError("每批最多上传 5 张图像，且不能超过预计帧数。")

    for offset, uploaded in enumerate(files):
        content = await uploaded.read(MAX_FRAME_BYTES + 1)
        if len(content) > MAX_FRAME_BYTES or len(content) < 24 or content[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError("图像帧无效或超过 30 MB。请降低输出尺寸后重试。")
        width, height = struct.unpack(">II", content[16:24])
        if (width, height) != (job.width, job.height):
            raise ValueError("图像帧尺寸与导出设置不一致。")
        (job.folder / f"frame_{start_index + offset:06d}.png").write_bytes(content)
        job.next_frame += 1
    job.progress = job.next_frame / job.frame_count
    return job.next_frame


async def encode_export(job: ExportJob) -> None:
    job.status = "encoding"
    job.progress = 0
    command = [
        shutil.which("ffmpeg") or "ffmpeg", "-y", "-v", "error",
        "-framerate", str(job.fps), "-i", str(job.folder / "frame_%06d.png"),
        "-frames:v", str(job.frame_count), "-an", "-c:v", "libx264", "-preset", "medium",
        "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostats", str(job.output_path),
    ]
    try:
        job.process = await asyncio.create_subprocess_exec(
            *command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        assert job.process.stdout is not None
        async for line in job.process.stdout:
            key, _, value = line.decode("utf-8", errors="ignore").strip().partition("=")
            if key == "frame":
                job.progress = min(1.0, float(value or 0) / job.frame_count)
        return_code = await job.process.wait()
        if return_code != 0 or not job.output_path.is_file() or job.output_path.stat().st_size == 0:
            job.status = "failed"
            job.error = "FFmpeg 编码失败。请确认已安装 FFmpeg，或降低导出分辨率后重试。"
            return
        job.progress = 1
        job.status = "completed"
        shutil.rmtree(job.folder)
    except asyncio.CancelledError:
        if job.process and job.process.returncode is None:
            job.process.terminate()
            try:
                await asyncio.wait_for(job.process.wait(), timeout=3)
            except asyncio.TimeoutError:
                job.process.kill()
                await job.process.wait()
        job.status = "cancelled"
        raise
    except Exception:
        job.status = "failed"
        job.error = "导出过程中发生错误。请查看本地服务状态后重试。"
    finally:
        job.process = None


async def cancel_export(job: ExportJob) -> None:
    if job.task and not job.task.done():
        job.task.cancel()
        try:
            await job.task
        except asyncio.CancelledError:
            pass
    if job.status not in {"completed", "failed"}:
        job.status = "cancelled"
    if job.folder.exists():
        shutil.rmtree(job.folder)


def export_status(job: ExportJob) -> dict:
    return {
        "exportId": job.export_id,
        "status": job.status,
        "progress": round(job.progress, 4),
        "receivedFrames": job.next_frame,
        "frameCount": job.frame_count,
        "error": job.error,
        "filename": job.output_path.name if job.status == "completed" else None,
    }
