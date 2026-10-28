from __future__ import annotations

import json
import math
import shutil
import subprocess
import uuid
from pathlib import Path

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parents[2]
TMP = ROOT / "tmp"
MAX_UPLOAD_BYTES = 500 * 1024 * 1024
MAX_SAMPLE_FRAMES = 300
PREVIEW_WIDTH = 640


class VideoError(ValueError):
    pass


def probe_video(path: Path) -> dict:
    executable = shutil.which("ffprobe")
    if not executable:
        raise VideoError("未找到 ffprobe。请安装 FFmpeg 后重新启动应用。")
    result = subprocess.run(
        [executable, "-v", "error", "-select_streams", "v:0", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise VideoError("无法读取视频信息。请确认文件是可播放的 MP4 或 MOV。")
    data = json.loads(result.stdout)
    streams = data.get("streams", [])
    if not streams:
        raise VideoError("文件中没有可读取的视频画面。")
    stream = streams[0]
    width, height = int(stream["width"]), int(stream["height"])
    rotate = int(stream.get("tags", {}).get("rotate", 0) or 0)
    for side in stream.get("side_data_list", []):
        if "rotation" in side:
            rotate = int(side["rotation"])
            break
    if abs(rotate) in (90, 270):
        width, height = height, width
    duration = float(data.get("format", {}).get("duration") or stream.get("duration") or 0)
    fps_text = stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "0/1"
    numerator, denominator = fps_text.split("/")
    fps = float(numerator) / max(float(denominator), 1)
    return {"duration": duration, "width": width, "height": height, "fps": fps}


def save_upload(filename: str, content: bytes) -> tuple[str, Path, dict]:
    if len(content) > MAX_UPLOAD_BYTES:
        raise VideoError("文件超过 500 MB 限制。请先裁剪视频后再导入。")
    suffix = Path(filename).suffix.lower()
    if suffix not in {".mp4", ".mov", ".m4v"}:
        raise VideoError("暂只支持 MP4、MOV、M4V 视频。")
    session_id = uuid.uuid4().hex
    folder = TMP / session_id
    folder.mkdir(parents=True, exist_ok=False)
    video_path = folder / f"source{suffix}"
    video_path.write_bytes(content)
    try:
        metadata = probe_video(video_path)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    if metadata["duration"] <= 0 or metadata["duration"] > 600:
        shutil.rmtree(folder, ignore_errors=True)
        raise VideoError("视频时长需在 0～10 分钟之间。建议先选择 5～10 秒片段。")
    return session_id, video_path, metadata


def _read_sampled_frames(video_path: Path, start: float, end: float, sample_fps: int) -> list[np.ndarray]:
    duration = end - start
    frame_count = math.ceil(duration * sample_fps)
    if frame_count > MAX_SAMPLE_FRAMES:
        raise VideoError(f"当前范围将生成 {frame_count} 帧，超过 {MAX_SAMPLE_FRAMES} 帧限制。请缩短范围或降低采样率。")
    executable = shutil.which("ffmpeg")
    if not executable:
        raise VideoError("未找到 FFmpeg。请安装 FFmpeg 后重新启动应用。")
    command = [executable, "-v", "error", "-ss", f"{start:.3f}", "-i", str(video_path),
               "-t", f"{duration:.3f}", "-vf", f"fps={sample_fps},scale='min({PREVIEW_WIDTH},iw)':-2",
               "-vsync", "0", "-f", "image2pipe", "-vcodec", "mjpeg", "-"]
    result = subprocess.run(command, capture_output=True, check=False)
    if result.returncode:
        raise VideoError("视频抽帧失败。请尝试重新导出为常规 H.264 MP4。")
    data = result.stdout
    frames = []
    marker = b"\xff\xd8"
    while True:
        begin = data.find(marker)
        if begin < 0:
            break
        finish = data.find(b"\xff\xd9", begin + 2)
        if finish < 0:
            break
        encoded = np.frombuffer(data[begin:finish + 2], dtype=np.uint8)
        image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        if image is not None:
            frames.append(image)
        data = data[finish + 2:]
    if len(frames) < 2:
        raise VideoError("所选范围抽取不到足够画面，请调整开始与结束时间。")
    return frames


def _detect_scene_cuts(frames: list[np.ndarray]) -> list[int]:
    """Return the first sampled-frame index of each high-confidence hard cut."""
    if len(frames) < 2:
        return []
    histograms = []
    for frame in frames:
        small = cv2.resize(frame, (64, 64), interpolation=cv2.INTER_AREA)
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        histogram = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
        cv2.normalize(histogram, histogram, alpha=1, norm_type=cv2.NORM_L1)
        histograms.append(histogram)
    return [
        index for index in range(1, len(histograms))
        if cv2.compareHist(histograms[index - 1], histograms[index], cv2.HISTCMP_BHATTACHARYYA) >= 0.55
    ]


def _scene_ranges(frame_count: int, cuts: list[int]) -> list[tuple[int, int]]:
    boundaries = [0, *sorted({cut for cut in cuts if 0 < cut < frame_count}), frame_count]
    return list(zip(boundaries[:-1], boundaries[1:]))


def _foreground_masks(frames: list[np.ndarray], background: np.ndarray, threshold: int,
                     method: str) -> list[np.ndarray]:
    if method == "median":
        masks = []
        for frame in frames:
            delta = cv2.absdiff(frame, background)
            gray = cv2.cvtColor(delta, cv2.COLOR_BGR2GRAY)
            _, mask = cv2.threshold(gray, int(threshold), 255, cv2.THRESH_BINARY)
            masks.append(mask)
        return masks

    history = max(30, min(120, len(frames)))
    subtractor = cv2.createBackgroundSubtractorMOG2(
        history=history, varThreshold=max(4, int(threshold)), detectShadows=False,
    )
    subtractor.apply(background, learningRate=1.0)
    return [subtractor.apply(frame, learningRate=1.0 / history) for frame in frames]


def _align_scene_frames(frames: list[np.ndarray]) -> tuple[list[np.ndarray], np.ndarray, int]:
    """Align only small, high-confidence global camera shifts within one shot."""
    height, width = frames[0].shape[:2]
    valid_common = np.full((height, width), 255, dtype=np.uint8)
    if len(frames) < 3:
        return frames, valid_common, 0

    detector = cv2.ORB_create(nfeatures=1000, fastThreshold=12)
    reference = frames[len(frames) // 2]
    reference_gray = cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY)
    reference_points, reference_descriptors = detector.detectAndCompute(reference_gray, None)
    if reference_descriptors is None or len(reference_points) < 12:
        return frames, valid_common, 0

    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    corners = np.float32([[[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]]])
    identity = np.eye(3, dtype=np.float64)
    aligned: list[np.ndarray] = []
    corrected_count = 0
    for frame in frames:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        points, descriptors = detector.detectAndCompute(gray, None)
        transform = identity
        alignment_accepted = False
        if descriptors is not None and len(points) >= 12:
            pairs = matcher.knnMatch(descriptors, reference_descriptors, k=2)
            good = [pair[0] for pair in pairs if len(pair) == 2 and pair[0].distance < 0.72 * pair[1].distance]
            if len(good) >= 12:
                source = np.float32([points[match.queryIdx].pt for match in good])
                destination = np.float32([reference_points[match.trainIdx].pt for match in good])
                candidate, inliers = cv2.findHomography(source, destination, cv2.RANSAC, 2.5)
                inlier_count = int(inliers.sum()) if inliers is not None else 0
                if candidate is not None and inlier_count >= 12 and inlier_count / len(good) >= 0.45:
                    mapped = cv2.perspectiveTransform(corners, candidate)
                    displacement = np.linalg.norm(mapped - corners, axis=2)
                    determinant = float(np.linalg.det(candidate[:2, :2]))
                    max_shift = max(height, width) * 0.04
                    if np.isfinite(candidate).all() and np.max(displacement) <= max_shift and 0.9 <= determinant <= 1.1:
                        transform = candidate
                        alignment_accepted = True
        if not alignment_accepted:
            return frames, np.full((height, width), 255, dtype=np.uint8), 0
        corrected = cv2.warpPerspective(frame, transform, (width, height), flags=cv2.INTER_LINEAR,
                                         borderMode=cv2.BORDER_REFLECT_101)
        valid = cv2.warpPerspective(np.full((height, width), 255, dtype=np.uint8), transform,
                                    (width, height), flags=cv2.INTER_NEAREST,
                                    borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        valid_common = cv2.bitwise_and(valid_common, valid)
        if np.max(np.abs(transform - identity)) > 0.5:
            corrected_count += 1
        aligned.append(corrected)
    if not corrected_count:
        return frames, np.full((height, width), 255, dtype=np.uint8), 0
    return aligned, valid_common, corrected_count


def _processing_warnings(mask_areas: list[float], scene_cut_count: int = 0,
                         skipped_transition_frames: int = 0, stabilized_frames: int = 0,
                         background_method: str = "median") -> list[str]:
    mean_area = float(np.mean(mask_areas))
    warnings = []
    if stabilized_frames:
        warnings.append(f"已对齐 {stabilized_frames} 张采样帧中的轻微全局镜头抖动。")
    if scene_cut_count:
        message = f"检测到 {scene_cut_count} 处明显切镜，已按镜头分别估计背景。"
        if skipped_transition_frames:
            message += f"其中 {skipped_transition_frames} 张过短镜头切片未生成主体蒙版。"
        message += "若只想表现一段动作，建议选取同一镜头的处理范围。"
        warnings.append(message)
    if max(mask_areas) < 0.002:
        warnings.append("部分帧几乎没有识别到运动主体，请尝试降低前景阈值。")
    if mean_area > 0.15:
        next_action = (
            "建议只处理单一固定镜头片段，或尝试动态背景模式。"
            if background_method == "median"
            else "可尝试固定背景模式，或只处理单一固定镜头片段。"
        )
        warnings.append(
            f"平均约 {mean_area:.0%} 的画面被判定为运动区域；镜头移动、场景切换或大面积动态背景可能让轨迹包含噪声。"
            + next_action
        )
    elif max(mask_areas) > 0.7:
        warnings.append("运动区域覆盖画面较大；该算法更适合固定机位。")
    return warnings


def process_video(video_path: Path, folder: Path, start: float, end: float,
                  sample_fps: int, threshold: int, blur: int, morph_size: int = 3,
                  background_method: str = "median") -> dict:
    metadata = probe_video(video_path)
    start = max(0.0, min(float(start), metadata["duration"]))
    end = max(start, min(float(end), metadata["duration"]))
    if end - start < 0.2:
        raise VideoError("处理范围至少需要 0.2 秒。")
    if sample_fps not in {5, 10, 15}:
        raise VideoError("采样率只能选择 5、10 或 15 FPS。")
    if background_method not in {"median", "mog2"}:
        raise VideoError("背景模型只能选择固定背景或动态背景。")
    frames = _read_sampled_frames(video_path, start, end, sample_fps)
    # Estimate a separate temporal-median background per shot so a hard cut does not
    # make both scenes appear as foreground in every sampled frame.
    cuts = _detect_scene_cuts(frames)
    scene_ranges = _scene_ranges(len(frames), cuts)
    output = folder / "frames"
    output.mkdir(exist_ok=True)
    full_output = folder / "full"
    full_output.mkdir(exist_ok=True)
    mask_areas = []
    morph_size = max(1, min(9, int(morph_size) | 1))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (morph_size, morph_size))
    blur_size = max(1, min(31, int(blur) | 1))
    skipped_transition_frames = 0
    stabilized_frames = 0
    for scene_start, scene_end in scene_ranges:
        scene_frames = frames[scene_start:scene_end]
        can_model_background = len(scene_frames) >= 3 or not cuts
        background = None
        aligned_frames, valid_mask, aligned_count = _align_scene_frames(scene_frames) if can_model_background else (scene_frames, None, 0)
        stabilized_frames += aligned_count
        if can_model_background:
            background = np.median(np.stack(aligned_frames, axis=0), axis=0).astype(np.uint8)
        if background is None:
            skipped_transition_frames += len(scene_frames)
        raw_masks = _foreground_masks(aligned_frames, background, threshold, background_method) if background is not None else []
        for local_index, index in enumerate(range(scene_start, scene_end)):
            frame = aligned_frames[local_index] if background is not None else frames[index]
            if background is None:
                clean = np.zeros(frame.shape[:2], dtype=np.uint8)
            else:
                mask = raw_masks[local_index]
                mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
                mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
                count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
                clean = np.zeros_like(mask)
                min_area = max(5, int(mask.size * 0.00005))
                for label in range(1, count):
                    if stats[label, cv2.CC_STAT_AREA] >= min_area:
                        clean[labels == label] = 255
                clean[valid_mask == 0] = 0
            alpha = cv2.GaussianBlur(clean, (blur_size, blur_size), 0) if blur_size > 1 else clean
            rgba = cv2.cvtColor(frame, cv2.COLOR_BGR2BGRA)
            rgba[:, :, 3] = alpha
            if not cv2.imwrite(str(output / f"{index:04d}.png"), rgba):
                raise VideoError("无法写入前景帧，请检查磁盘空间。")
            full_rgba = cv2.cvtColor(frames[index], cv2.COLOR_BGR2BGRA)
            if not cv2.imwrite(str(full_output / f"{index:04d}.png"), full_rgba):
                raise VideoError("无法写入完整画面帧，请检查磁盘空间。")
            mask_areas.append(float(np.count_nonzero(clean)) / clean.size)
    return {
        "width": int(frames[0].shape[1]), "height": int(frames[0].shape[0]),
        "frameCount": len(frames), "sampleFps": sample_fps,
        "times": [start + index / sample_fps for index in range(len(frames))],
        "maskAreas": mask_areas,
        "warnings": _processing_warnings(mask_areas, len(cuts), skipped_transition_frames,
                                         stabilized_frames, background_method),
    }
