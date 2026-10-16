"""Validate an exported MP4 against its JSON report. No browser is launched.

python3 test/verify.py output/movie.mp4 [--reference output/baseline.mp4]
"""
import argparse
from fractions import Fraction
import json
from pathlib import Path
import re
import subprocess


def run(*args):
    return subprocess.run([str(a) for a in args], capture_output=True, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    ap.add_argument("--reference", type=Path)
    args = ap.parse_args()
    report = json.loads(Path(str(args.video) + ".json").read_text())
    stream = json.loads(run("ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_streams", "-of", "json", args.video).stdout)["streams"][0]
    frames = report["frames"]
    fps = Fraction(report["fpsNum"], report["fpsDen"])
    assert int(stream["nb_read_frames"]) == frames, "Missing/extra frames"
    assert Fraction(stream["avg_frame_rate"]) == fps, "Frame rate mismatch"
    expected_size = (report["width"], report["height"])
    assert (stream["width"], stream["height"]) == expected_size, "Resolution mismatch"
    assert abs(float(stream["duration"]) - frames / float(fps)) < 0.00001, "Duration mismatch"
    packets = json.loads(run("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_packets", "-show_entries", "packet=pts_time,dts_time,flags", "-of", "json", args.video).stdout)["packets"]
    assert len(packets) == frames
    assert "K" in packets[0]["flags"], "First sample must be independently decodable"
    for i, packet in enumerate(packets):
        expected = i / float(fps)
        assert abs(float(packet["pts_time"]) - expected) < 0.00001, f"PTS mismatch at {i}"
        assert abs(float(packet["dts_time"]) - expected) < 0.00001, f"DTS mismatch at {i}"
    # Actually decode all samples, including frames after GOP boundaries.
    run("ffmpeg", "-v", "error", "-i", args.video, "-f", "null", "-")
    print(f"PASS {args.video.name}: {frames} frames, {fps} fps, exact CFR timeline, full decode")
    if args.reference:
        reference = json.loads(Path(str(args.reference) + ".json").read_text())
        for key in ("page", "scene", "start", "frames", "scale", "codec", "bitrate", "fpsNum", "fpsDen"):
            assert report[key] == reference[key], f"Comparison settings differ: {key}"
        result = run("ffmpeg", "-hide_banner", "-i", args.reference, "-i", args.video, "-lavfi", "ssim", "-f", "null", "-")
        match = re.search(r"All:([0-9.]+)", result.stderr.decode())
        assert match, "SSIM was not reported"
        score = float(match.group(1))
        assert score > 0.97, f"Large image discrepancy (SSIM {score})"
        print(f"PASS encoded-image comparison: SSIM={score:.6f} (not pixel-identical or a color-management proof)")


if __name__ == "__main__":
    main()
