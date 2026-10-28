from pathlib import Path

import cv2
import numpy as np

from backend.app import main


def test_full_frame_endpoint_uses_full_frame_folder(tmp_path, monkeypatch):
    session_id = "a" * 32
    monkeypatch.setattr(main, "TMP", tmp_path)
    for folder, color in (("frames", (0, 0, 255)), ("full", (255, 0, 0))):
        output = tmp_path / session_id / folder
        output.mkdir(parents=True)
        assert cv2.imwrite(str(output / "0000.png"), np.full((4, 4, 3), color, dtype=np.uint8))

    assert Path(main.frame(session_id, "0000.png").path).parent.name == "frames"
    assert Path(main.full_frame(session_id, "0000.png").path).parent.name == "full"


def test_output_download_is_available_by_filename_after_restart(tmp_path, monkeypatch):
    monkeypatch.setattr(main.exports, "OUTPUTS", tmp_path)
    output = tmp_path / "walking-sample-a1b2c3d4.mp4"
    output.write_bytes(b"encoded video")

    assert Path(main.output_download(output.name).path) == output
