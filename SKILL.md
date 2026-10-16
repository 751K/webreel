---
name: webreel
description: 把 HTML 动画页面导出成视频（MP4、10-bit HEVC、ProRes、带透明通道的 ProRes 4444），不逐帧截屏。用于"把这个网页 / 动画做成视频""导出 MP4 / MOV""生成一段视频素材"这类任务；也用于先检查页面能不能正确导出。
---

# webreel：网页动画 → 视频

先 `check`，再导出，每次调用都加 `--json`，然后读 stdout 上的那一个 JSON 对象。日志和进度在 stderr，不用解析。

## 命令

```bash
webreel check page.html --json --out shots/      # 不导出：检查页面，把开头 / 中间 / 结尾三帧存成 PNG
webreel page.html --out out/movie.mp4 --json     # 导出
webreel batch jobs.json --json                   # 多段一起导出（默认 2 个并行），可选无损拼接
```

`webreel` 不在 PATH 上时，用 `node <webreel 仓库>/render.mjs` 代替，参数相同。在仓库里运行一次 `npm install -g .` 就能装上 `webreel` 命令。

需要 Node.js 20+ 和 Google Chrome。`--depth 10`、`--codec prores`、`--alpha` 还需要带 VideoToolbox 的 ffmpeg（macOS）。

## 工作流程

1. **写页面**，按下面的"页面规范"。
2. **检查**：`webreel check page.html --json --out shots/`
   - 打开 `stills` 里的 PNG 看画面对不对。
   - `capture` 是 `"screenshot"` 时，导出会退回截屏方式，慢几倍，`fallbackReason` 写了原因。能改页面就改，改不了也能导出。
   - `checksPass` 为 `false` 时，正式导出会失败，要么改页面，要么导出时加 `--capture screenshot`。
   - `duration` 为 `null` 时，导出必须加 `--duration 秒数`。
   - `hints` 里的每一条都是要处理的事。
3. **导出**：`webreel page.html --out out/movie.mp4 --json`，看结果里的 `ok`、`output`、`warnings`。
4. **失败时**：按 `error.hint` 处理，见下面的"错误代码"。不要原样重试同一条命令。

有多段素材时，写一个批量文件，而不是一段一段地导出：

```json
{ "defaults": { "scale": 2, "depth": 10 },
  "jobs": [ { "page": "a.html", "out": "a.mov" }, { "page": "b.html", "out": "b.mov", "duration": 8 } ],
  "concat": [ { "out": "ab.mov", "parts": ["a.mov", "b.mov"] } ] }
```

- **参数写法**：键就是命令行参数去掉 `--`，开关写 `true`，`null` 去掉默认值。路径相对于批量文件。
- **启动前检查**：开始之前会先检查所有任务，任何一个有问题就都不启动。
- **单个任务失败**：不影响其他任务。
- **结果**：`{ ok, jobs: [{ name, ok, out, frames, capture, error? }], concat: [{ out, ok, frames, error? }] }`。
- **重跑**：只重跑失败的任务，用一个只含这些任务的新批量文件，或者单独导出。
- **并行数**：不要把 `--parallel` 调高到 2 以上，除非机器内存远大于 16 GB。实测 3 个反而更慢。

## 页面规范

- **尺寸**：单个 HTML 文件，在 `<head>` 里写 `<meta name="viewport" content="width=1920, height=1080">`（宽高为偶数），`body` 的 margin 设为 0。
- **动画**：用 CSS 动画、Web Animations 或 `requestAnimationFrame`，加载后立刻开始，不等点击或滚动。
- **长度**：只有 CSS 动画或 Web Animations 并且都会结束时，长度能自动推算；用了 `requestAnimationFrame`、计时器或无限循环时，导出要加 `--duration`。
- **资源**：图片、字体内联或放在同目录，不要用 `setTimeout` 轮询等资源加载。
- **选择器**：样式不要依赖 `body > …` 这类子选择器，导出时页面内容会被包一层。
- **canvas / WebGL**：
  - 放在底层，文字和标注叠在上面；不要用不透明的整块面板盖住 canvas；
  - canvas 上面不要放毛玻璃（`backdrop-filter`）；
  - canvas 和它的外层元素不要用 `mask`、旋转、镜像翻转；外层元素不要加 `filter` / `mix-blend-mode`。
  - 圆角、边框、阴影、`filter`、`clip-path` 基本形状、`object-fit` 都没问题。
- **透明视频**（`--alpha`）：`html` / `body` 不设背景，WebGL 用 `alpha: true` 并 `clearColor(0, 0, 0, 0)`。
- **可选的精确模式**：页面能按时间画出任意一帧时，定义下面这个对象，导出更快，`--start` 也能直接跳转：

  ```js
  window.webreel = { frame(t) { /* 画出第 t 秒 */ }, duration: 12 };
  ```

  `frame(t)` 画出的画面只能取决于 t。

## 常用参数

| 需要 | 参数 |
|---|---|
| 指定长度 / 片段 | `--duration 秒`、`--start 秒` |
| 帧率 | `--fps 30`、`--fps 60000/1001`（默认 60） |
| 4K（1920×1080 的页面） | `--scale 2`，并用 `--codec hevc` 或 `--depth 10` |
| 剪辑交付 | `--depth 10 --out x.mov`（HEVC Main10），或 `--codec prores --out x.mov`（422 HQ） |
| 透明背景 | `--alpha --out x.mov`（ProRes 4444） |
| 覆盖已有文件 | `--overwrite`（只在确实要替换时用） |
| 检查指定时刻 | `check … --at 0,1.5,3` |

## JSON 结果

- **导出**：
  - `ok`：成功为 `true`；
  - `output`：成片路径；`report`：详细报告的路径；
  - `width` / `height`、`frames`、`duration`；
  - `capture`：`html-in-canvas`（快速方式）或 `screenshot`；`fallbackReason`：改用截屏的原因；
  - `checks`：抽查结果，每项有 `t`、`mean`、`worstTile`、`pass`；
  - `warnings`。
- **check**：
  - 除了上面的 `capture`、`fallbackReason`、`checks`，还有 `checksPass`、`duration`（推算不出时为 `null`）、`frameCount`、`clock`（是否接管了页面时钟）；
  - `stills`：每项是 `{ t, path }`；
  - `hints`、`warnings`。
- **失败**：`{ "ok": false, "error": { "code", "message", "hint" } }`。

## 错误代码

| code | 退出码 | 怎么处理 |
|---|---|---|
| `USAGE` | 2 | 参数写错了，看 `message` 和 `hint` |
| `OUTPUT_EXISTS` | 2 | 换一个 `--out`；确定要覆盖时才加 `--overwrite` |
| `NEEDS_DURATION` | 3 | 加 `--duration 秒数` |
| `INTERVAL` | 3 | `--start` + `--duration` 超过了页面长度，改小 |
| `PAGE` / `PAGE_LOAD` / `NO_FRAME_SOURCE` | 3 | 页面本身有问题：尺寸不对、加载不完、没有可用的帧来源。按 `hint` 改页面 |
| `CHECK_FAILED` | 4 | 快速方式画出的帧和浏览器不一致。按"页面规范"改页面，或加 `--capture screenshot` 重新导出 |
| `HIC_REFUSED` | 4 | 用了 `--capture hic`，但页面没法用快速方式导出。去掉这个参数（自动改用截屏），或改页面 |
| `UNSUPPORTED_STYLE` | 4 | 导出中途出现了无法还原的样式，加 `--capture screenshot` |
| `CHROME_NOT_FOUND` / `FFMPEG` / `SOFTWARE_GL` / `HIC_UNAVAILABLE` / `ENCODER` | 5 | 环境问题，按 `hint` 处理，或报告给用户 |
| `ERROR` | 1 | 其他错误，把 `message` 报告给用户 |

## 不要做

- **跳过抽查**：不要用 `--check 0` 绕过 `CHECK_FAILED`，那样交出去的视频可能是错的。改用 `--capture screenshot`。
- **软件渲染**：不要随手加 `--allow-software`。软件渲染 WebGL 很慢，画面也可能和 GPU 渲染的不同。
- **用不透明的 MP4 交付透明素材**：H.264 / HEVC 没有透明通道，透明素材要用 `--alpha`。

完整参数：`webreel --help`。给人看的说明见 [README.md](README.md)。
