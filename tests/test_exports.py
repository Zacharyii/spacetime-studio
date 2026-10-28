import asyncio
import io
import json
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np
import pytest
from starlette.datastructures import UploadFile

from backend.app import exports


@pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="FFmpeg tools are required")
def test_export_encodes_h264_mp4_and_preserves_requested_dimensions(tmp_path, monkeypatch):
    temp_root = tmp_path / "tmp"
    session_id = "b" * 32
    session = temp_root / session_id
    session.mkdir(parents=True)
    (session / "source.mp4").write_bytes(b"test source placeholder")
    monkeypatch.setattr(exports, "TMP", temp_root)
    monkeypatch.setattr(exports, "OUTPUTS", tmp_path / "outputs")
    job = exports.create_export(session_id, 2, 720, 1280, 30)

    image = np.zeros((1280, 720, 3), dtype=np.uint8)
    image[:, :, 1] = 140
    encoded = cv2.imencode(".png", image)[1].tobytes()

    async def render():
        files = [UploadFile(io.BytesIO(encoded), filename=f"frame-{index}.png") for index in range(2)]
        await exports.append_frames(job, 0, files)
        await exports.encode_export(job)

    asyncio.run(render())
    assert job.status == "completed"
    assert not job.folder.exists()
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=codec_name,width,height,pix_fmt,avg_frame_rate", "-of", "json", str(job.output_path)],
        check=True, capture_output=True, text=True,
    )
    stream = json.loads(probe.stdout)["streams"][0]
    assert stream["codec_name"] == "h264"
    assert (stream["width"], stream["height"]) == (720, 1280)
    assert stream["pix_fmt"] == "yuv420p"
    assert stream["avg_frame_rate"] == "30/1"


def test_cancel_export_removes_only_generated_frames(tmp_path, monkeypatch):
    temp_root = tmp_path / "tmp"
    session_id = "c" * 32
    session = temp_root / session_id
    session.mkdir(parents=True)
    source = session / "source.mp4"
    source.write_bytes(b"original video")
    monkeypatch.setattr(exports, "TMP", temp_root)
    monkeypatch.setattr(exports, "OUTPUTS", tmp_path / "outputs")
    job = exports.create_export(session_id, 1, 720, 1280, 30)

    asyncio.run(exports.cancel_export(job))

    assert job.status == "cancelled"
    assert not job.folder.exists()
    assert source.read_bytes() == b"original video"


def test_export_uses_safe_source_name_and_unique_suffix(tmp_path, monkeypatch):
    temp_root = tmp_path / "tmp"
    session_id = "d" * 32
    session = temp_root / session_id
    session.mkdir(parents=True)
    (session / "source.mp4").write_bytes(b"source")
    monkeypatch.setattr(exports, "TMP", temp_root)
    monkeypatch.setattr(exports, "OUTPUTS", tmp_path / "outputs")

    first = exports.create_export(session_id, 1, 720, 1280, 30, "../My clip!.mp4")
    second = exports.create_export(session_id, 1, 720, 1280, 30, "../My clip!.mp4")

    assert first.output_path.parent == tmp_path / "outputs"
    assert first.output_path.name.startswith("My-clip-")
    assert first.output_path != second.output_path


def test_startup_cleanup_removes_only_abandoned_export_frames(tmp_path, monkeypatch):
    temp_root = tmp_path / "tmp"
    session_id = "e" * 32
    source = temp_root / session_id / "source.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"original video")
    abandoned = temp_root / "exports" / "abandoned"
    abandoned.mkdir(parents=True)
    (abandoned / "frame_000000.png").write_bytes(b"temporary frame")
    monkeypatch.setattr(exports, "TMP", temp_root)

    exports.cleanup_abandoned_export_frames()

    assert not abandoned.exists()
    assert source.read_bytes() == b"original video"
