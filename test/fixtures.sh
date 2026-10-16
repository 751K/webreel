#!/bin/sh
# Fixture checks for render.mjs: the window.webreel contract, the screenshot
# fallback, and a page the frame check must reject.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixtures="$root/test/fixtures"
out="$root/output/fixtures"
mkdir -p "$out"
render() { node "$root/render.mjs" "$@" --overwrite; }
expect() { if grep -q "$1" "$2"; then echo "PASS $3"; else echo "FAIL $3"; cat "$2"; exit 1; fi; }

render "$fixtures/protocol.html" --out "$out/protocol.mp4" > "$out/protocol.log" 2>&1
expect '^html-in-canvas:' "$out/protocol.log" 'window.webreel page (1280×720 viewport, WebGL under DOM) uses html-in-canvas'
python3 "$root/test/verify.py" "$out/protocol.mp4"

render "$fixtures/protocol.html" --scale 2 --out "$out/protocol-2x.mp4" > "$out/protocol-2x.log" 2>&1
expect '2560×1440' "$out/protocol-2x.log" '--scale 2 renders device pixels'
python3 "$root/test/verify.py" "$out/protocol-2x.mp4"

render "$fixtures/covered.html" --out "$out/covered.mp4" > "$out/covered.log" 2>&1
expect '^screenshot (fallback: Opaque page content' "$out/covered.log" 'opaque DOM over WebGL falls back to screenshots'
grep -q 'virtual clock' "$out/covered.log" && { echo 'FAIL the older name window.film was not recognised'; exit 1; } || echo 'PASS the older name window.film still works (covered.html)'
python3 "$root/test/verify.py" "$out/covered.mp4"

if render "$fixtures/covered.html" --capture hic --out "$out/covered-hic.mp4" > "$out/covered-hic.log" 2>&1; then echo 'FAIL --capture hic must refuse covered.html'; exit 1; fi
expect 'Opaque page content' "$out/covered-hic.log" '--capture hic refuses instead of falling back'

if render "$fixtures/selector.html" --out "$out/selector.mp4" > "$out/selector.log" 2>&1; then echo 'FAIL the frame check must reject selector.html'; exit 1; fi
expect 'Frame check failed' "$out/selector.log" 'frame check rejects a page whose CSS breaks when wrapped'
test ! -e "$out/selector.mp4" && echo 'PASS rejected export leaves no output'

# Pages without window.webreel run on the virtual clock.
render "$fixtures/clock-css.html" --fps 30 --out "$out/clock-css.mp4" > "$out/clock-css.log" 2>&1
expect 'length 2.500 s inferred' "$out/clock-css.log" 'CSS-only page: virtual clock, length inferred from its animations'
expect '^html-in-canvas:' "$out/clock-css.log" 'CSS-only page uses html-in-canvas'
python3 "$root/test/verify.py" "$out/clock-css.mp4"
python3 - "$out/clock-css.mp4" <<'PY'
# The box slides 0 → 1000 px over 2 s, linearly: check its position per frame time.
import subprocess, sys
for n, expected in [(15, 250), (30, 500), (45, 750), (60, 1000)]:
    row = subprocess.run(['ffmpeg', '-v', 'error', '-i', sys.argv[1], '-vf', f'select=eq(n\\,{n}),crop=1920:2:0:660', '-vframes', '1',
                          '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], capture_output=True, check=True).stdout
    red = [x for x in range(1920) if row[3*x] > 200 and row[3*x+1] < 120 and row[3*x+2] < 150]
    assert red and abs(red[0] - expected) <= 2, f'frame {n}: box at {red[:1]}, expected {expected}'
print('PASS CSS animation positions follow the frame time')
PY

render "$fixtures/clock-raf.html" --fps 30 --duration 3 --out "$out/clock-raf.mp4" > "$out/clock-raf.log" 2>&1
expect '^html-in-canvas:' "$out/clock-raf.log" 'stateful requestAnimationFrame + timers page exports on the virtual clock'
python3 "$root/test/verify.py" "$out/clock-raf.mp4"

render "$fixtures/clock-timeline.html" --fps 30 --duration 3 --out "$out/clock-timeline.mp4" > "$out/clock-timeline.log" 2>&1
expect '^html-in-canvas:' "$out/clock-timeline.log" 'tween ticker + Web Animations page exports on the virtual clock'
python3 "$root/test/verify.py" "$out/clock-timeline.mp4"

if render "$fixtures/clock-raf.html" --out "$out/clock-raf-nolength.mp4" > "$out/clock-raf-nolength.log" 2>&1; then echo 'FAIL a rAF page without --duration must be refused'; exit 1; fi
expect 'pass --duration' "$out/clock-raf-nolength.log" 'rAF page without --duration asks for one'

# 10-bit: HEVC Main10 through ffmpeg on the host.
render "$fixtures/protocol.html" --depth 10 --out "$out/protocol-10bit.mov" > "$out/protocol-10bit.log" 2>&1
expect 'HEVC Main10' "$out/protocol-10bit.log" '--depth 10 exports HEVC Main10'
python3 "$root/test/verify.py" "$out/protocol-10bit.mov"
probe=$(ffprobe -v error -select_streams v:0 -show_entries stream=profile,pix_fmt,color_transfer,color_space -of csv=p=0 "$out/protocol-10bit.mov")
test "$probe" = 'Main 10,yuv420p10le,bt709,bt709' && echo "PASS 10-bit stream is Main 10 / yuv420p10le / BT.709" || { echo "FAIL 10-bit stream: $probe"; exit 1; }
# Main10 frames are converted to P010 on the GPU; the RGBA path (ffmpeg converts) is the reference.
grep -q '"readback": "p010 (WebGPU)"' "$out/protocol-10bit.mov.json" || { echo 'FAIL --depth 10 did not read back P010'; exit 1; }
WEBREEL_READBACK=rgba node "$root/render.mjs" "$fixtures/protocol.html" --depth 10 --overwrite --out "$out/protocol-10bit-rgba.mov" > "$out/protocol-10bit-rgba.log" 2>&1
ssim=$(ffmpeg -hide_banner -i "$out/protocol-10bit-rgba.mov" -i "$out/protocol-10bit.mov" -lavfi ssim -f null - 2>&1 | sed -n 's/.*All:\([0-9.]*\).*/\1/p')
python3 -c "import sys; sys.exit(float('$ssim') < 0.995)" && echo "PASS GPU P010 matches ffmpeg's conversion (SSIM $ssim)" || { echo "FAIL GPU P010 differs from ffmpeg's conversion (SSIM $ssim)"; exit 1; }
render "$fixtures/protocol.html" --q nogpu --depth 10 --out "$out/protocol-nogpu.mov" > "$out/protocol-nogpu.log" 2>&1
expect 'P010 readback unavailable' "$out/protocol-nogpu.log" 'without WebGPU, --depth 10 falls back to RGBA readback'
grep -q '"readback": "rgba"' "$out/protocol-nogpu.mov.json" || { echo 'FAIL fallback report does not say rgba'; exit 1; }

# ProRes: 422 HQ through the same host encoder.
render "$fixtures/protocol.html" --codec prores --out "$out/protocol-prores.mov" > "$out/protocol-prores.log" 2>&1
expect 'ProRes 422 HQ' "$out/protocol-prores.log" '--codec prores exports ProRes 422 HQ'
python3 "$root/test/verify.py" "$out/protocol-prores.mov"
probe=$(ffprobe -v error -select_streams v:0 -show_entries stream=profile,codec_tag_string,pix_fmt,color_space -of csv=p=0 "$out/protocol-prores.mov")
test "$probe" = 'HQ,apch,yuv422p10le,bt709' && echo "PASS ProRes stream is 422 HQ / yuv422p10le / BT.709" || { echo "FAIL ProRes stream: $probe"; exit 1; }

# --alpha: a page without background exports transparent ProRes 4444, on both capture paths.
for capture in auto screenshot; do
  render "$fixtures/alpha.html" --alpha --capture $capture --fps 30 --duration 2 --out "$out/alpha-$capture.mov" > "$out/alpha-$capture.log" 2>&1
  expect 'ProRes 4444 with alpha' "$out/alpha-$capture.log" "--alpha exports ProRes 4444 with alpha (--capture $capture)"
  python3 - "$out/alpha-$capture.mov" <<'PY'
# Straight alpha as the page painted it: empty stage, the 55% card, the 60% WebGL triangle.
import subprocess, sys
probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=profile,pix_fmt', '-of', 'csv=p=0', sys.argv[1]], capture_output=True, text=True).stdout.strip()
assert probe == '4444,yuva444p12le', probe
W = 1280
frame = subprocess.run(['ffmpeg', '-v', 'error', '-i', sys.argv[1], '-vf', 'select=eq(n\\,59),scale=in_color_matrix=bt709:in_range=tv,format=rgba',
                        '-frames:v', '1', '-f', 'rawvideo', '-'], capture_output=True, check=True).stdout
pixel = lambda x, y: frame[(y * W + x) * 4:(y * W + x) * 4 + 4]
for (x, y), (rgb, alpha) in {(20, 20): (None, 0), (1000, 150): ((59, 143, 217), 140), (320, 330): ((240, 71, 112), 153)}.items():
    p = pixel(x, y)
    assert abs(p[3] - alpha) <= 3, f'alpha at {x},{y}: {p[3]}, expected {alpha}'
    assert rgb is None or all(abs(a - b) <= 4 for a, b in zip(p, rgb)), f'colour at {x},{y}: {tuple(p[:3])}, expected {rgb}'
print('PASS alpha channel keeps empty, 55% and 60% coverage')
PY
done
grep -q 'opaque everywhere' "$out/alpha-auto.log" && { echo 'FAIL transparent page warned as opaque'; exit 1; } || true
render "$fixtures/protocol.html" --alpha --duration 0.5 --out "$out/protocol-alpha.mov" > "$out/protocol-alpha.log" 2>&1
expect 'opaque everywhere' "$out/protocol-alpha.log" '--alpha warns when the page paints its own background'
if render "$fixtures/alpha.html" --alpha --codec hevc --out "$out/alpha.mp4" > "$out/alpha-hevc.log" 2>&1; then echo 'FAIL --alpha with HEVC must be refused'; exit 1; fi
expect 'no alpha channel' "$out/alpha-hevc.log" '--alpha refuses codecs without an alpha channel'
# Without --alpha the same page sits on the browser's white backdrop, as in a screenshot.
render "$fixtures/alpha.html" --fps 30 --duration 2 --out "$out/alpha-opaque.mp4" > "$out/alpha-opaque.log" 2>&1
expect '^html-in-canvas:' "$out/alpha-opaque.log" 'a page without background exports on white and passes the frame check'

# CSS on canvases and videos: reproduced on the fast path, or refused before the export.
render "$fixtures/media-styles.html" --capture hic --out "$out/media-styles.mp4" > "$out/media-styles.log" 2>&1
expect '^html-in-canvas:' "$out/media-styles.log" 'radius, border, shadow, filter, blend, clip-path, object-fit and ancestor clipping pass the frame check'
for case in 'backdrop:backdrop-filter over' 'mask:has a CSS mask' 'mirror:is mirrored' 'parent-filter:around <canvas#gl> has a filter'; do
  name=${case%%:*}; message=${case#*:}
  render "$fixtures/media-fallback.html" --q "case=$name" --duration 0.2 --out "$out/media-$name.mp4" > "$out/media-$name.log" 2>&1
  expect "^screenshot (fallback: .*$message" "$out/media-$name.log" "$name around a canvas falls back to screenshots"
done

# For agents: --json puts exactly one JSON object on stdout, errors carry a code,
# a hint and an exit code; `check` reports without exporting and saves stills.
json() { python3 -c "import json, sys; d = json.load(open(sys.argv[1])); print(eval(sys.argv[2], {}, d))" "$@"; }
render "$fixtures/protocol.html" --duration 0.5 --json --out "$out/json.mp4" > "$out/json.out" 2> "$out/json.err"
test "$(json "$out/json.out" 'ok and command == "render" and frames == 30 and output.endswith("json.mp4")')" = True && echo 'PASS --json prints the render result on stdout' || { echo 'FAIL --json render result'; cat "$out/json.out"; exit 1; }
set +e; render "$fixtures/clock-raf.html" --json --out "$out/json-fail.mp4" > "$out/json-fail.out" 2> /dev/null; status=$?; set -e
test "$status" = 3 && test "$(json "$out/json-fail.out" 'not ok and error["code"] == "NEEDS_DURATION" and "--duration" in error["hint"]')" = True \
  && echo 'PASS --json error: code NEEDS_DURATION, a hint, exit code 3' || { echo "FAIL --json error (exit $status)"; cat "$out/json-fail.out"; exit 1; }
rm -rf "$out/stills"
node "$root/render.mjs" check "$fixtures/clock-css.html" --fps 30 --at 0.5,1 --json --out "$out/stills" > "$out/check.out" 2> /dev/null
test "$(json "$out/check.out" 'ok and command == "check" and clock and capture == "html-in-canvas" and checksPass and len(stills) == 2 and abs(total - 2.5) < 1e-6')" = True \
  && test -s "$out/stills/clock-css-0.500s.png" && test -s "$out/stills/clock-css-1.000s.png" \
  && echo 'PASS check: virtual clock, inferred length, passing checks, PNG stills' || { echo 'FAIL check'; cat "$out/check.out"; exit 1; }
node "$root/render.mjs" check "$fixtures/covered.html" --json > "$out/check-covered.out" 2> /dev/null
test "$(json "$out/check-covered.out" 'capture == "screenshot" and "Opaque page content" in fallbackReason and any("screenshots" in h for h in hints)')" = True \
  && echo 'PASS check reports the screenshot fallback and why' || { echo 'FAIL check fallback'; cat "$out/check-covered.out"; exit 1; }
node "$root/render.mjs" check "$fixtures/selector.html" --json > "$out/check-selector.out" 2> /dev/null
test "$(json "$out/check-selector.out" 'not checksPass and any("--capture screenshot" in h for h in hints)')" = True \
  && echo 'PASS check reports frames that would fail the export, without failing itself' || { echo 'FAIL check selector'; cat "$out/check-selector.out"; exit 1; }

# batch: a process pool, one failing job that does not stop the others, lossless joins.
mkdir -p "$out/batch"
cat > "$out/batch/jobs.json" <<JOBS
{
  "defaults": { "fps": "60000/1001", "duration": 1 },
  "jobs": [
    { "page": "$fixtures/protocol.html", "out": "a.mov", "depth": 10 },
    { "page": "$fixtures/protocol.html", "out": "b.mov", "depth": 10, "start": 1 },
    { "page": "$fixtures/clock-raf.html", "out": "raf.mp4", "name": "raf", "duration": null }
  ],
  "concat": [ { "out": "ab.mov", "parts": ["a.mov", "b.mov"] } ]
}
JOBS
set +e; node "$root/render.mjs" batch "$out/batch/jobs.json" --overwrite --json > "$out/batch.out" 2> "$out/batch.err"; status=$?; set -e
test "$status" = 3 && test "$(json "$out/batch.out" '[j["ok"] for j in jobs] == [True, True, False] and jobs[2]["error"]["code"] == "NEEDS_DURATION" and concat[0]["ok"] and concat[0]["frames"] == 120')" = True \
  && echo 'PASS batch: jobs run in a pool, a failed job is reported with its code, the others finish' || { echo "FAIL batch (exit $status)"; cat "$out/batch.out"; exit 1; }
python3 "$root/test/verify.py" "$out/batch/ab.mov"
probe=$(ffprobe -v error -select_streams v:0 -show_entries stream=profile,pix_fmt,color_space -of csv=p=0 "$out/batch/ab.mov")
test "$probe" = 'Main 10,yuv420p10le,bt709' && echo 'PASS joined parts keep Main 10 / BT.709' || { echo "FAIL joined stream: $probe"; exit 1; }
if node "$root/render.mjs" batch "$out/batch/jobs.json" --json > "$out/batch-exists.out" 2> /dev/null; then echo 'FAIL batch must refuse existing outputs before starting'; exit 1; fi
test "$(json "$out/batch-exists.out" 'error["code"] == "OUTPUT_EXISTS"')" = True && echo 'PASS batch validates every job (existing output) before starting any' || { cat "$out/batch-exists.out"; exit 1; }
