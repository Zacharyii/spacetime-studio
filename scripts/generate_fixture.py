from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "tests" / "fixtures" / "fixed_camera_moving_circle.mp4"
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
width, height, fps, duration = 640, 360, 30, 5
writer = cv2.VideoWriter(str(OUTPUT), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
if not writer.isOpened():
    raise SystemExit("无法创建 MP4。请检查 OpenCV 视频编码支持。")
for index in range(fps * duration):
    image = np.full((height, width, 3), (33, 39, 46), np.uint8)
    cv2.rectangle(image, (18, 24), (622, 336), (42, 51, 59), 2)
    cv2.circle(image, (80 + int(480 * index / (fps * duration - 1)), 180), 34, (70, 210, 245), -1)
    writer.write(image)
writer.release()
print(f"已生成测试视频: {OUTPUT} ({width}×{height}, {fps} FPS, {duration} 秒)")
