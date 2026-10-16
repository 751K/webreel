# webreel 速查（给 agent）

把 HTML 动画页面导出成视频。命令：`webreel`，不在 PATH 上时用 `node <webreel 仓库>/render.mjs`。每次都加 `--json`：stdout 上只有一个 JSON 对象，日志在 stderr。

## 三步

```bash
webreel check page.html --json --out shots/            # 1. 检查，存开头/中间/结尾 PNG
webreel page.html --depth 10 --out out/a.mov --json    # 2. 导出
webreel batch jobs.json --json                         # 多段：批量导出（默认 2 个并行）
```

1. **check**：
   - 打开 `stills` 里的 PNG 看画面。
   - `checksPass` 为 false：先改页面，否则正式导出会失败。
   - `duration` 为 null：导出时必须加 `--duration 秒`。
   - `hints` 每条都要处理。
2. **导出**：看 `ok`、`output`、`warnings`。
3. **失败时**：按 `error.hint` 改，不要原样重试同一条命令。

## 页面要求

- **尺寸**：单个 HTML 文件；`<meta name="viewport" content="width=1920, height=1080">`（宽高为偶数）；`body { margin: 0 }`。
- **动画**：加载后立刻自动开始，不等点击。
  - 只用有限次的 CSS 动画或 Web Animations 时，长度会自动推算；
  - 用了 rAF、计时器或无限循环时，必须加 `--duration`。
- **资源**：图片、字体放同目录或内联。样式不要依赖 `body > …`。
- **WebGL / canvas**：
  - 放在底层，文字叠在上面；不要用不透明的整块面板盖住它，上面不要用 `backdrop-filter`；
  - 它和它的外层元素不要用 mask、旋转、镜像；
  - 外层元素不要加 filter / mix-blend-mode。
- **透明视频**：`html` / `body` 不设背景；WebGL 用 `alpha: true` 并 `clearColor(0,0,0,0)`。

## 常用参数

| 要什么 | 参数 |
|---|---|
| 剪辑用成片（默认选这个） | `--depth 10 --out x.mov`（HEVC Main10） |
| 4K（1920×1080 页面） | `--scale 2` |
| 帧率 | `--fps 30`、`--fps 60000/1001`（默认 60） |
| 片段 | `--start 秒 --duration 秒` |
| ProRes | `--codec prores --out x.mov`（422 HQ） |
| 透明背景 | `--alpha --out x.mov`（ProRes 4444） |
| 覆盖已有文件 | `--overwrite`（确定要替换时才加） |

## 批量文件

```json
{ "defaults": { "scale": 2, "depth": 10 },
  "jobs": [ { "page": "a.html", "out": "a.mov" }, { "page": "b.html", "out": "b.mov", "duration": 8 } ],
  "concat": [ { "out": "ab.mov", "parts": ["a.mov", "b.mov"] } ] }
```

- **写法**：键就是参数名去掉 `--`，开关写 `true`；路径相对于批量文件。
- **启动前**：先检查全部任务，有一个不对就都不启动。
- **失败时**：单个失败不影响其他任务，只重跑失败的那些。
- **并行数**：`--parallel` 不要调到 2 以上，16 GB 机器上 3 个反而更慢。

## 错误代码

| code | 怎么办 |
|---|---|
| `USAGE`（退出码 2） | 参数错了，看 `message` |
| `OUTPUT_EXISTS`（2） | 换一个 `--out`，或确认后加 `--overwrite` |
| `NEEDS_DURATION`（3） | 加 `--duration` |
| `INTERVAL`（3） | `--start` + `--duration` 超过了页面长度 |
| `PAGE` / `PAGE_LOAD` / `NO_FRAME_SOURCE`（3） | 页面本身有问题，按 `hint` 改 |
| `CHECK_FAILED` / `UNSUPPORTED_STYLE`（4） | 按上面的页面要求改，或加 `--capture screenshot` 重导 |
| `HIC_REFUSED`（4） | 去掉 `--capture hic` |
| `CHROME_NOT_FOUND` / `FFMPEG` / `SOFTWARE_GL` / `ENCODER`（5） | 环境问题，报告给用户 |

## 不要做

- 用 `--check 0` 绕过 `CHECK_FAILED`：交出去的视频可能是错的。
- 随手加 `--allow-software`：软件渲染很慢，画面也可能不对。
- 用 MP4 交付透明素材：MP4 没有透明通道，要用 `--alpha`。
- 为了验证批量文件写得对不对就去跑 `batch`：它会直接开始完整导出。

详细说明：[SKILL.md](SKILL.md)、[README.md](README.md)。
