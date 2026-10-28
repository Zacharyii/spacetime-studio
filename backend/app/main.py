import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import exports
from .processing import MAX_SAMPLE_FRAMES, TMP, VideoError, process_video, save_upload


@asynccontextmanager
async def lifespan(_: FastAPI):
    exports.cleanup_abandoned_export_frames()
    yield


app = FastAPI(title="Space-Time Studio Local API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
                   allow_methods=["GET", "POST", "DELETE"], allow_headers=["*"])


class ExportStart(BaseModel):
    sessionId: str
    frameCount: int
    width: int
    height: int
    fps: int = 30
    outputName: str | None = None


@app.get("/api/health")
def health():
    return {"status": "ok", "maxSampleFrames": MAX_SAMPLE_FRAMES}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    try:
        content = await file.read(500 * 1024 * 1024 + 1)
        session_id, _, metadata = save_upload(file.filename or "video.mp4", content)
        return {"sessionId": session_id, **metadata}
    except VideoError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/process")
def process(sessionId: str = Form(...), start: float = Form(...), end: float = Form(...),
            sampleFps: int = Form(10), threshold: int = Form(28), blur: int = Form(5), morphSize: int = Form(3),
            backgroundMethod: str = Form("median")):
    if not sessionId.isalnum() or len(sessionId) != 32:
        raise HTTPException(status_code=400, detail="素材会话无效，请重新上传视频。")
    folder = TMP / sessionId
    video_candidates = list(folder.glob("source.*"))
    if not video_candidates:
        raise HTTPException(status_code=404, detail="找不到上传的视频，请重新上传。")
    try:
        result = process_video(video_candidates[0], folder, start, end, sampleFps, threshold, blur,
                               morphSize, backgroundMethod)
        result["sessionId"] = sessionId
        result["frameUrls"] = [f"/api/frame/{sessionId}/{index:04d}.png" for index in range(result["frameCount"])]
        result["fullFrameUrls"] = [f"/api/frame/{sessionId}/full/{index:04d}.png" for index in range(result["frameCount"])]
        return result
    except VideoError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _frame_response(session_id: str, filename: str, full: bool):
    if not session_id.isalnum() or len(session_id) != 32 or not filename.endswith(".png") or Path(filename).name != filename:
        raise HTTPException(status_code=404, detail="找不到帧图像。")
    path = TMP / session_id / ("full" if full else "frames") / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="找不到帧图像。")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-store"})


@app.get("/api/frame/{session_id}/{filename}")
def frame(session_id: str, filename: str):
    return _frame_response(session_id, filename, False)


@app.get("/api/frame/{session_id}/full/{filename}")
def full_frame(session_id: str, filename: str):
    return _frame_response(session_id, filename, True)


@app.post("/api/export/start")
def export_start(request: ExportStart):
    try:
        job = exports.create_export(request.sessionId, request.frameCount, request.width, request.height, request.fps, request.outputName)
        return exports.export_status(job)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/export/{export_id}/frames/{start_index}")
async def export_frames(export_id: str, start_index: int, files: list[UploadFile] = File(...)):
    job = exports.get_export(export_id)
    if not job:
        raise HTTPException(status_code=404, detail="导出任务不存在或已过期。")
    try:
        received = await exports.append_frames(job, start_index, files)
        return {"receivedFrames": received, "frameCount": job.frame_count}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/export/{export_id}/finish")
async def export_finish(export_id: str):
    job = exports.get_export(export_id)
    if not job:
        raise HTTPException(status_code=404, detail="导出任务不存在或已过期。")
    if job.status != "receiving" or job.next_frame != job.frame_count:
        raise HTTPException(status_code=400, detail="尚未收到全部图像帧，无法开始编码。")
    job.task = asyncio.create_task(exports.encode_export(job))
    return exports.export_status(job)


@app.get("/api/export/{export_id}/status")
def export_status(export_id: str):
    job = exports.get_export(export_id)
    if not job:
        raise HTTPException(status_code=404, detail="导出任务不存在或已过期。")
    return exports.export_status(job)


@app.delete("/api/export/{export_id}")
async def export_cancel(export_id: str):
    job = exports.get_export(export_id)
    if not job:
        raise HTTPException(status_code=404, detail="导出任务不存在或已过期。")
    await exports.cancel_export(job)
    return exports.export_status(job)


@app.get("/api/export/{export_id}/download")
def export_download(export_id: str):
    job = exports.get_export(export_id)
    if not job or job.status != "completed" or not job.output_path.is_file():
        raise HTTPException(status_code=404, detail="视频尚未导出完成。")
    return FileResponse(job.output_path, media_type="video/mp4", filename=job.output_path.name)


@app.get("/api/output/{filename}")
def output_download(filename: str):
    if Path(filename).name != filename or not filename.endswith(".mp4"):
        raise HTTPException(status_code=404, detail="找不到导出视频。")
    path = exports.OUTPUTS / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="找不到导出视频。")
    return FileResponse(path, media_type="video/mp4", filename=filename)
