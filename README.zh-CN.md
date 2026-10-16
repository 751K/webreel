# webreel

[English](README.md)

把会动的网页导出成视频：MP4、10-bit HEVC，或 ProRes（可带透明通道）。页面不用为导出做任何修改：CSS 动画、Web Animations、`requestAnimationFrame` 循环、计时器、canvas 和 WebGL 都能直接导出。

webreel 主要给 agent 用：agent 写好页面、调用 webreel、读一个 JSON 结果。见[给 agent 用](#给-agent-用)。

```bash
webreel page.html --out movie.mp4
```

## 准备

- **macOS**：在 Apple Silicon 上测试过。
- **Node.js 20 或更新版本**。
- **Google Chrome**：用较新的版本。装在 `/Applications` 里会自动找到，装在别处时用 `--chrome 路径` 指定。
- **ffmpeg**：只有导出 10-bit（`--depth 10`）、ProRes 和透明视频时需要，可以用 `brew install ffmpeg` 安装。

## 安装

没有依赖要装。在仓库目录里运行下面的命令，装上 `webreel` 命令：

```bash
npm install -g .
```

也可以不装，用 `node render.mjs` 代替 `webreel`，参数相同。

## 用法

导出整个页面：

```bash
webreel page.html --out movie.mp4
```

只导出一段，从第 2 秒开始，导出 3 秒：

```bash
webreel page.html --start 2 --duration 3 --out part.mp4
```

页面里有无限循环的动画时，要指定长度：

```bash
webreel page.html --duration 10 --out movie.mp4
```

指定帧率：

```bash
webreel page.html --fps 60000/1001 --out movie.mp4
```

1920×1080 的页面导出成 4K：

```bash
webreel page.html --scale 2 --codec hevc --out movie-4k.mp4
```

10-bit HEVC（Main10），给剪辑、调色用。推荐用它交付：

```bash
webreel page.html --scale 2 --depth 10 --out movie-4k.mov
```

ProRes 422 HQ。用 `--prores` 可以换档位：

```bash
webreel page.html --codec prores --out movie.mov
```

透明视频（ProRes 4444）。页面没有背景的地方，视频是透明的：

```bash
webreel overlay.html --alpha --out overlay.mov
```

透明通道是非预乘的（straight）。在剪辑软件里如果边缘发黑或发白，把素材的 alpha 方式设成 straight。

每个视频旁边都会生成一份 `.json` 报告。

### 先检查，再导出

`webreel check` 不导出视频，只报告这几件事：

- 画面尺寸和长度；
- 能不能走快速导出；
- 画出的帧和浏览器里看到的是否一致。

同时会把开头、中间、结尾三帧存成 PNG：

```bash
webreel check page.html --out shots/
```

也可以指定检查哪几个时刻：

```bash
webreel check page.html --at 0,1.5,3 --out shots/
```

### 批量导出

多段素材写在一个文件里，一条命令导出，默认 2 个同时进行：

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

- **写法**：任务里的键就是参数名去掉 `--`，开关写 `true`；路径相对于这个文件。
- **启动前检查**：开始之前会先检查所有任务，有一个不对就都不启动。
- **失败互不影响**：一个任务失败，其他任务照常完成。
- **`concat`**：把导出完的几段无损拼成一个文件。
- **`--parallel N`**：同时进行几个任务。16 GB 内存的机器上 2 个最快。

## 给 agent 用

加上 `--json` 后，stdout 上只有一个 JSON 对象，日志都输出到 stderr：

```bash
webreel page.html --out movie.mp4 --json
```

- **成功**：`{"ok": true, "output": …, "frames": …, "checks": […], "warnings": […], …}`
- **失败**：`{"ok": false, "error": {"code": "NEEDS_DURATION", "message": …, "hint": …}}`
- **退出码**：0 成功，2 参数错误，3 页面问题，4 抽查失败，5 环境问题（Chrome、ffmpeg、GPU），1 其他。

给 agent 的说明有两份：

- [MANUAL.md](MANUAL.md)：一页的速查，可以直接贴进提示词。
- [SKILL.md](SKILL.md)：完整的工作流程和错误代码，按 Claude Code skill 的格式写。安装方法：

```bash
mkdir -p ~/.claude/skills && ln -s "$PWD" ~/.claude/skills/webreel
```

## 页面怎么写

- **尺寸**：默认 1920×1080。要改尺寸，在 `<head>` 里写 `<meta name="viewport" content="width=1280, height=720">`，宽高用偶数。`--scale` 在这个尺寸上放大。
- **长度**：页面只有会结束的 CSS 动画或 Web Animations 时，长度会自动推算；否则要加 `--duration`。
- **开始**：动画在页面加载后立刻开始，不要等点击或滚动。
- **资源**：图片、字体内联，或者和页面放在同一目录。加载时不要用 `setTimeout` 轮询。
- **选择器**：样式不要依赖 `body > …` 这类子选择器。
- **canvas / WebGL**：
  - 放在底层，文字和标注叠在上面；
  - 上面不要盖不透明的整块面板，也不要盖毛玻璃（`backdrop-filter`）面板；
  - 它和它的外层元素不要用 `mask`、旋转、镜像翻转；
  - 外层元素不要加 `filter` 或 `mix-blend-mode`。

  不符合这些规则时，webreel 会自动改用截屏方式导出：慢一些，但结果仍然正确。
- **透明视频**：`html` 和 `body` 不设背景。WebGL 用 `{ alpha: true }`，并用 `clearColor(0, 0, 0, 0)` 清屏。

### 可选：让页面自己画每一帧

如果页面能按要求画出任意时刻 `t` 的画面，可以定义下面这个对象。这样导出更快，`--start` 也会直接跳到起点：

```js
window.webreel = {
  frame(t) { /* 画出第 t 秒的画面；可以返回 Promise */ },
  duration: 12,              // 长度（秒）
  width: 1920, height: 1080, // 可选
  ready: promise,            // 可选：等资源加载完再开始导出
};
```

`frame(t)` 画出的画面只能取决于 `t`。导出时页面里会有 `window.webreelHost`。

## 参数

| 参数 | 默认 | 作用 |
|---|---|---|
| `--out 文件` | 必填 | 输出文件；`check` 时是存 PNG 的目录 |
| `--json` | 关 | 在 stdout 输出一个 JSON 结果 |
| `--start 秒` / `--duration 秒` | 0 / 到结束 | 导出哪一段 |
| `--fps N` 或 `N/D` | 60 | 帧率 |
| `--scale 1\|2\|3` | 1 | 放大倍数 |
| `--codec h264\|hevc\|prores` | h264 | 编码 |
| `--depth 8\|10` | 8 | 10：HEVC Main10（`.mov` / `.mp4`） |
| `--prores 档位` | hq | `proxy`、`lt`、`standard`、`hq`、`4444`、`xq` |
| `--alpha` | 关 | 透明视频（ProRes 4444） |
| `--bitrate 比特每秒` | 1080p 约 24 Mbps | H.264 / HEVC 码率；10-bit 不指定时用恒定质量 |
| `--overwrite` | 关 | 覆盖已有文件 |
| `--at 秒,秒,…` | 开头、中间、结尾 | 只用于 `check`：检查哪几个时刻 |
| `--parallel N` | 2 | 只用于 `batch`：同时进行几个任务 |
| `--capture auto\|hic\|screenshot` | auto | 抓帧方式；`screenshot` 总能用 |
| `--check N` | 3 | 导出后和浏览器对比几帧 |
| `--q 'a=1&b=2'` | | 加在页面地址后的参数 |
| `--root 目录` | 页面所在目录 | 页面能读取哪些文件 |
| `--chrome 路径` / `--ffmpeg 路径` | 自动查找 | 可执行文件的位置 |

全部参数见 `webreel --help`。

## 常见问题

| 提示 | 怎么办 |
|---|---|
| `pass --duration` | 页面里的动画不会结束，加 `--duration 秒数` |
| `Falling back to screenshots` | 导出照常完成，只是慢一些。提示里写了原因，见[页面怎么写](#页面怎么写) |
| `Frame check failed` | 这次没有生成文件。改页面，或者加 `--capture screenshot` 重新导出 |
| `Output already exists` | 换一个 `--out`，或者加 `--overwrite` |
| `WebGL fell back to software` | 在能用 GPU 的普通终端里运行，不要在沙箱里运行 |
| `ffmpeg not found` | `brew install ffmpeg`，或者用 `--ffmpeg 路径` 指定 |

## 限制

- **没有音频**。
- **10-bit、ProRes 和透明视频只能在 macOS 上导出**：它们要用 VideoToolbox。
- **用到了 Chrome 的实验功能**：快速导出依赖这个功能。如果升级 Chrome 后出问题，先用 `--capture screenshot` 导出。
- **页面里的 `<video>`**：播放进度不受导出时间控制。

## 许可证

[MIT](LICENSE)
