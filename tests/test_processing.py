from pathlib import Path
import math
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from backend.app import processing
from backend.app.processing import _align_scene_frames, _foreground_masks, _processing_warnings, process_video, probe_video

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "fixed_camera_moving_circle.mp4"

def test_16_seconds_at_15_fps_accepts_240_sample_frames(monkeypatch):
    encoded_frames = b"\xff\xd8\xff\xd9" * 240
    monkeypatch.setattr(processing.subprocess, "run", lambda *_args, **_kwargs: SimpleNamespace(returncode=0, stdout=encoded_frames))
    monkeypatch.setattr(processing.cv2, "imdecode", lambda *_args: np.zeros((2, 2, 3), dtype=np.uint8))

    frames = processing._read_sampled_frames(FIXTURE, 0, 16, 15)

    assert len(frames) == 240

def test_fixture_metadata():
    info = probe_video(FIXTURE)
    assert info["duration"] == pytest.approx(5, abs=0.1)
    assert info["width"] == 640
    assert info["height"] == 360

def test_stationary_background_is_transparent_and_moving_circle_is_foreground(tmp_path):
    result = process_video(FIXTURE, tmp_path, 0, 5, 10, 24, 5)
    assert result["frameCount"] == 50
    assert 0.003 < max(result["maskAreas"]) < 0.2
    rgba = cv2.imread(str(tmp_path / "frames" / "0010.png"), cv2.IMREAD_UNCHANGED)
    assert rgba is not None and rgba.shape[2] == 4
    assert rgba[:, :, 3].max() > 200
    assert np.count_nonzero(rgba[:, :, 3] == 0) > rgba.shape[0] * rgba.shape[1] // 2
    assert not any("平均约" in warning for warning in result["warnings"])

def test_large_mean_mask_warns_about_dynamic_background():
    warnings = _processing_warnings([0.18, 0.22, 0.26])
    assert len(warnings) == 1
    assert "平均约 22%" in warnings[0]
    assert "单一固定镜头" in warnings[0]

def test_fixed_camera_walking_silhouette_tracks_motion(tmp_path):
    video = tmp_path / "walking-silhouette.mp4"
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"mp4v"), 30, (640, 360))
    assert writer.isOpened()
    background = np.zeros((360, 640, 3), dtype=np.uint8)
    background[:] = (48, 58, 68)
    for x in range(0, 640, 40):
        cv2.line(background, (x, 0), (x, 359), (54, 64, 74), 1)
    for index in range(150):
        frame = background.copy()
        x = 95 + index * 3
        bob = round(math.sin(index / 7) * 3)
        head_y = 132 + bob
        color = (25, 135, 245)
        cv2.circle(frame, (x, head_y), 16, color, -1, cv2.LINE_AA)
        cv2.ellipse(frame, (x, 185 + bob), (23, 39), 0, 0, 360, color, -1, cv2.LINE_AA)
        cv2.line(frame, (x - 8, 213 + bob), (x - 18, 265 + bob), color, 12, cv2.LINE_AA)
        cv2.line(frame, (x + 8, 213 + bob), (x + 20, 265 + bob), color, 12, cv2.LINE_AA)
        cv2.line(frame, (x - 9, 168 + bob), (x - 32, 198 + bob), color, 10, cv2.LINE_AA)
        cv2.line(frame, (x + 9, 168 + bob), (x + 34, 188 + bob), color, 10, cv2.LINE_AA)
        writer.write(frame)
    writer.release()

    processed_dir = tmp_path / "processed"
    processed_dir.mkdir()
    result = process_video(video, processed_dir, 0, 5, 10, 24, 5)
    centroids = []
    for index in (10, 30):
        rgba = cv2.imread(str(processed_dir / "frames" / f"{index:04d}.png"), cv2.IMREAD_UNCHANGED)
        moments = cv2.moments(rgba[:, :, 3])
        centroids.append(moments["m10"] / moments["m00"])
    assert result["frameCount"] == 50
    assert centroids[1] > centroids[0] + 100
    assert max(result["maskAreas"]) < 0.15

def test_hard_scene_cut_uses_independent_background_models(tmp_path):
    video = tmp_path / "two-shots.mp4"
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"mp4v"), 30, (640, 360))
    assert writer.isOpened()
    for index in range(120):
        shot_frame = index % 60
        background = (45, 45, 45) if index < 60 else (190, 35, 35)
        frame = np.full((360, 640, 3), background, dtype=np.uint8)
        x = (100 if index < 60 else 330) + shot_frame
        cv2.circle(frame, (x, 180), 15, (20, 220, 240), -1, cv2.LINE_AA)
        writer.write(frame)
    writer.release()

    processed_dir = tmp_path / "processed"
    processed_dir.mkdir()
    result = process_video(video, processed_dir, 0, 4, 10, 24, 5)
    assert result["frameCount"] == 40
    assert max(result["maskAreas"]) < 0.12
    assert any("检测到 1 处明显切镜" in warning and "分别估计背景" in warning for warning in result["warnings"])

def test_small_global_camera_shake_is_aligned_without_stopping_subject_motion():
    height, width = 360, 640
    background = np.full((height, width, 3), 40, dtype=np.uint8)
    rng = np.random.default_rng(7)
    for y in range(15, height, 35):
        for x in range(15, width, 35):
            color = tuple(int(value) for value in rng.integers(60, 180, size=3))
            cv2.rectangle(background, (x, y), (x + int(rng.integers(5, 18)), y + int(rng.integers(5, 18))), color, -1)
    frames = []
    for index in range(12):
        frame = background.copy()
        cv2.circle(frame, (130 + index * 18, 180), 14, (20, 210, 240), -1)
        dx = round(3 * math.sin(index * math.pi / 5))
        dy = round(2 * math.cos(index * math.pi / 5))
        matrix = np.float32([[1, 0, dx], [0, 1, dy]])
        frames.append(cv2.warpAffine(frame, matrix, (width, height), borderMode=cv2.BORDER_REFLECT_101))

    aligned, valid, corrected_count = _align_scene_frames(frames)
    assert corrected_count >= 8
    reference = frames[len(frames) // 2]
    raw_difference = np.mean([cv2.absdiff(frame, reference)[valid > 0].mean() for frame in frames])
    aligned_difference = np.mean([cv2.absdiff(frame, reference)[valid > 0].mean() for frame in aligned])
    assert aligned_difference < raw_difference * 0.7

def test_mog2_reduces_periodic_background_noise_while_retaining_moving_subject():
    height, width = 180, 320
    frames = []
    targets = []
    for index in range(60):
        columns = np.arange(width)[None, :]
        stripe = ((columns + index * 4) // 12 % 2) * 55
        frame = np.empty((height, width, 3), dtype=np.uint8)
        frame[:] = (36, 44, 52)
        frame[:, :, 1] = np.clip(frame[:, :, 1].astype(np.int16) + stripe, 0, 255).astype(np.uint8)
        center = (35 + index * 4, 90)
        cv2.circle(frame, center, 11, (30, 220, 245), -1, cv2.LINE_AA)
        target = np.zeros((height, width), dtype=np.uint8)
        cv2.circle(target, center, 11, 255, -1)
        frames.append(frame)
        targets.append(target)

    background = np.median(np.stack(frames, axis=0), axis=0).astype(np.uint8)
    median_masks = _foreground_masks(frames, background, 28, "median")
    mog2_masks = _foreground_masks(frames, background, 28, "mog2")
    median_false_positive = np.mean([np.mean(mask[target == 0] > 0) for mask, target in zip(median_masks[30:], targets[30:])])
    mog2_false_positive = np.mean([np.mean(mask[target == 0] > 0) for mask, target in zip(mog2_masks[30:], targets[30:])])
    mog2_recall = np.mean([np.mean(mask[target > 0] > 0) for mask, target in zip(mog2_masks[30:], targets[30:])])
    assert mog2_false_positive < median_false_positive * 0.2
    assert mog2_recall > 0.8
