# webreel

[中文](README.zh-CN.md)

Export an animated web page to a video file — MP4, 10-bit HEVC, or ProRes (with alpha) — without changing the page. CSS animations, Web Animations, `requestAnimationFrame` loops, timers, canvas and WebGL all work as they are.

webreel is built to be driven by agents: an agent writes a page, runs webreel, and reads one JSON result. See [For agents](#for-agents).

```bash
webreel page.html --out movie.mp4
```

## Requirements

- **macOS**. Tested on Apple Silicon.
- **Node.js 20+**.
- **Google Chrome**, a recent version. It is found automatically in `/Applications`; otherwise pass `--chrome PATH`.
- **ffmpeg**, only for 10-bit (`--depth 10`), ProRes and `--alpha`: `brew install ffmpeg`.

## Install

There are no dependencies. Install the `webreel` command from the repository folder:

```bash
npm install -g .
```

You can also skip installing and run `node render.mjs` with the same arguments.

## Usage

The whole page:

```bash
webreel page.html --out movie.mp4
```

A section of it, from 2 s for 3 s:

```bash
webreel page.html --start 2 --duration 3 --out part.mp4
```

Pages with endless animations need a length:

```bash
webreel page.html --duration 10 --out movie.mp4
```

Another frame rate:

```bash
webreel page.html --fps 60000/1001 --out movie.mp4
```

4K from a 1920×1080 page:

```bash
webreel page.html --scale 2 --codec hevc --out movie-4k.mp4
```

10-bit HEVC (Main10) for editing and grading. This is the recommended delivery format:

```bash
webreel page.html --scale 2 --depth 10 --out movie-4k.mov
```

ProRes 422 HQ (use `--prores` for other profiles):

```bash
webreel page.html --codec prores --out movie.mov
```

A transparent video (ProRes 4444). Wherever the page has no background, the video is transparent:

```bash
webreel overlay.html --alpha --out overlay.mov
```

The alpha is straight (not premultiplied). If edges look dark or light in your editor, set the clip's alpha mode to straight.

Next to every video, webreel writes a `.json` report.

### Check before exporting

`webreel check` exports nothing. It reports:

- the page size and length;
- whether the fast capture path works;
- whether frames match what the browser shows.

It also saves the first, middle and last frames as PNG:

```bash
webreel check page.html --out shots/
```

To check specific moments:

```bash
webreel check page.html --at 0,1.5,3 --out shots/
```

### Batch export

List several exports in one file. By default, two run at a time:

```bash
webreel batch jobs.json
```

```json
{
  "defaults": { "scale": 2, "depth": 10 },
  "jobs": [
    { "page": "intro.html", "out": "01_intro.mov" },
    { "page": "scene.html", "out": "02a_scene.mov", "duration": 8 },
    { "page": "outro.html", "out": "02b_outro.mov" }
  ],
  "concat": [ { "out": "02_ending.mov", "parts": ["02a_scene.mov", "02b_outro.mov"] } ]
}
```

- **Keys**: a job key is an option without `--`; flags take `true`. Paths are relative to the batch file.
- **Validation**: every job is checked before any starts.
- **Failures**: a failed job does not stop the others.
- **`concat`**: joins finished parts losslessly.
- **`--parallel N`**: jobs at a time. 2 is fastest on a 16 GB machine.

## For agents

Add `--json`. Then stdout has exactly one JSON object, and logs go to stderr:

```bash
webreel page.html --out movie.mp4 --json
```

- **On success**: `{"ok": true, "output": …, "frames": …, "checks": […], "warnings": […], …}`
- **On failure**: `{"ok": false, "error": {"code": "NEEDS_DURATION", "message": …, "hint": …}}`
- **Exit codes**: 0 ok, 2 usage, 3 page, 4 frame check, 5 environment (Chrome, ffmpeg, GPU), 1 other.

Two instruction files for agents are included (in Chinese):

- [MANUAL.md](MANUAL.md): a one-page quick reference to paste into a prompt.
- [SKILL.md](SKILL.md): the full workflow and error codes, as a Claude Code skill. Install it with:

```bash
mkdir -p ~/.claude/skills && ln -s "$PWD" ~/.claude/skills/webreel
```

## Writing pages

- **Size**: 1920×1080 by default. Set another size in `<head>` with `<meta name="viewport" content="width=1280, height=720">`. Use even numbers. `--scale` multiplies the size.
- **Length**: inferred when the page only has finite CSS animations or Web Animations. Otherwise pass `--duration`.
- **Start**: animations start on load, without a click or scroll.
- **Assets**: inline images and fonts, or keep them next to the page. Don't poll with `setTimeout` while loading.
- **Selectors**: don't rely on `body > …` child selectors.
- **Canvas / WebGL**:
  - keep it underneath, with text and labels on top;
  - don't cover it with an opaque panel or a `backdrop-filter` panel;
  - don't use `mask`, rotation or mirroring on it or its parents;
  - don't put `filter` or `mix-blend-mode` on its parents.

  If a page breaks these rules, webreel falls back to screenshots: it is slower, but the result is still correct.
- **Transparency**: leave `html` and `body` without a background. For WebGL, use `{ alpha: true }` and `clearColor(0, 0, 0, 0)`.

### Optional: drawing frames yourself

If the page can draw any moment `t` on request, define this object. Exports are faster, and `--start` jumps straight to the start:

```js
window.webreel = {
  frame(t) { /* draw the page at t seconds; may return a Promise */ },
  duration: 12,              // seconds
  width: 1920, height: 1080, // optional
  ready: promise,            // optional: wait for assets before exporting
};
```

`frame(t)` must depend only on `t`. During an export, `window.webreelHost` is set.

## Options

| Option | Default | |
|---|---|---|
| `--out FILE` | required | Output file. For `check`, a folder for PNG stills |
| `--json` | off | One JSON result on stdout |
| `--start S` / `--duration S` | 0 / to the end | Section to export |
| `--fps N` or `N/D` | 60 | Frame rate |
| `--scale 1\|2\|3` | 1 | Output scale |
| `--codec h264\|hevc\|prores` | h264 | Codec |
| `--depth 8\|10` | 8 | 10: HEVC Main10 (`.mov` / `.mp4`) |
| `--prores PROFILE` | hq | `proxy`, `lt`, `standard`, `hq`, `4444`, `xq` |
| `--alpha` | off | Transparent video (ProRes 4444) |
| `--bitrate BPS` | ~24 Mbps at 1080p | H.264 / HEVC bitrate. 10-bit uses constant quality unless set |
| `--overwrite` | off | Replace an existing output |
| `--at T,T,…` | first, middle, last | `check` only: moments to check |
| `--parallel N` | 2 | `batch` only: jobs at a time |
| `--capture auto\|hic\|screenshot` | auto | Capture path. `screenshot` always works |
| `--check N` | 3 | Frames compared with the browser after the export |
| `--q 'a=1&b=2'` | | Query string for the page |
| `--root DIR` | page folder | Files the page may load |
| `--chrome PATH` / `--ffmpeg PATH` | auto | Executables |

For all options, run `webreel --help`.

## Troubleshooting

| Message | What to do |
|---|---|
| `pass --duration` | The page animates forever. Add `--duration SECONDS` |
| `Falling back to screenshots` | The export still works, only slower. The message says why; see [Writing pages](#writing-pages) |
| `Frame check failed` | No file was written. Fix the page, or export with `--capture screenshot` |
| `Output already exists` | Pick another `--out`, or add `--overwrite` |
| `WebGL fell back to software` | Run in a normal terminal with GPU access, not a sandbox |
| `ffmpeg not found` | `brew install ffmpeg`, or pass `--ffmpeg PATH` |

## Limitations

- **No audio**.
- **macOS only for 10-bit, ProRes and alpha**: these need VideoToolbox.
- **Experimental Chrome feature**: the fast capture path uses an experimental Chrome feature. If a Chrome update breaks it, use `--capture screenshot`.
- **`<video>` elements**: their playback is not driven by the export clock.

## License

[MIT](LICENSE)
