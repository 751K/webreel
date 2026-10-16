# webreel 设计说明

写给维护者：说明导出工具怎么工作、为什么这样设计、数据是怎么测的，以及怎么测试。使用方法见 [README.md](README.md)（中文版 [README.zh-CN.md](README.zh-CN.md)）。

## 文件

| 文件 | 作用 |
|---|---|
| [SKILL.md](SKILL.md) | 给 agent 的说明：工作流程、页面规范、错误代码 |
| [render.mjs](render.mjs) | 命令行入口和宿主进程（`render` / `check` 两个子命令、`--json`、错误代码）：启动 Chrome（CDP pipe）、只读地提供页面目录、写 MP4、把原始帧交给 ffmpeg（10-bit、ProRes）、执行截屏请求、给虚拟时钟页面跑参照重放 |
| [page/export.mjs](page/export.mjs) | 注入页面的模块：识别帧来源、html-in-canvas 合成、截屏后备、WebCodecs 编码或读出原始帧、抽查 |
| [page/media.mjs](page/media.mjs) | 把作用在 canvas / video 内容上的 CSS 用 Canvas 2D 重现：圆角、裁剪、`object-fit`、`filter`、`clip-path`、混合模式；判断哪些样式无法重现 |
| [page/clock.js](page/clock.js) | 虚拟时钟，在页面脚本运行前注入 |
| [page/mp4.mjs](page/mp4.mjs) | 固定帧率 AVC / HEVC 的 MP4 封装；样本数据流式写入，内存里只保留样本大小和关键帧表 |
| [page/gpu.mjs](page/gpu.mjs) | `--depth 10` 的读回：直接从合成画布取帧，在 GPU 上（WebGPU 计算着色器）转成 P010，再读出；抽查用的 RGBA 也从这里读 |
| [page/ssim.mjs](page/ssim.mjs) | 8×8 窗口亮度 SSIM，同时报告最差的 128×128 区块；带透明度时分别叠在黑底和白底上比较 |

## 一帧怎么导出

1. **推进时间**：
   - 页面有 `window.webreel`（或旧名 `window.film`）时，调用 `frame(t)`；
   - 旧页面调用 `renderAt(scene, t)`；
   - 都没有时，由虚拟时钟推进一帧。
2. **画出这一帧**：
   - 整页 DOM（script 除外）先移进一个尺寸明确的舞台 `div`，再放进 `<canvas layoutsubtree>`，由 Chrome 自己的绘制器用 `drawElementImage` 画进画布（html-in-canvas）。
   - 嵌在页面里的 `<canvas>` / `<video>`，快照里的内容不可靠，所以用 `clip-path` 只把内容区从快照里挖掉，边框、轮廓和外阴影仍由快照画；内容由合成器按 CSS 画在底层，见"canvas / video 的样式"。
   - 这些元素自身和祖先若有纯色背景，背景会被临时设为透明，改由合成器按各自的圆角和裁剪填在最下面。背景总是画在内容和后代下面，所以这样不会改变层次。
   - 画布底色取 body / html 的背景色；都没有时为白色，和浏览器截图一致。早先这里填黑色，没写背景的页面会因此抽查失败。`--alpha` 时不填底色。
3. **编码**：
   - 先复制到另一张 OffscreenCanvas（`--alpha` 以外都是不透明的），再交给 `VideoEncoder`。直接从带 alpha 的宿主画布编码时，编码器会在中途换配置。
   - 压缩数据分批 POST 给宿主写盘。10-bit 和 ProRes 不走 WebCodecs，见下一节。

Chrome 默认启动参数：

- `--disable-frame-rate-limit --disable-gpu-vsync`：不加的话，每次 `requestPaint` 都要等一次 60 Hz 垂直同步，大约占一半时间。
- `--enable-blink-features=CanvasDrawElement`：打开 html-in-canvas。

html-in-canvas 已知的特性：

- 在 `<canvas layoutsubtree>` 里，子元素的 `inset: 0` 和百分比尺寸不会以画布为基准，会塌成 0×0，所以舞台要写死像素尺寸；
- 元素外的阴影会被裁掉，所以总是画整张舞台；
- 4K 是真正按设备像素绘制的，不是把 1080p 放大。

## 10-bit 输出（`--depth 10`）

Chrome 155 的 WebCodecs 不支持 10-bit 编码：在本机，HEVC Main10 和 AV1 10-bit 两种配置，`isConfigSupported` 都返回 false，硬件和软件两种模式都一样。所以 10-bit 改走另一条路：

1. **页面**：每帧画好后，在 GPU 上转成 P010（见下面"GPU 上转 P010"），逐帧 POST 给宿主。最多两帧在途。
2. **宿主**：收齐一整帧后交给 ffmpeg 的 stdin，在后台写入，最多积压两帧；积压满了才延迟回应页面，这样形成背压。
3. **ffmpeg**：直接用 `hevc_videotoolbox -profile:v main10` 编码，不再转换。默认 `-q:v 80`，传了 `--bitrate` 时改用 `-b:v`。另外：`-bf 0`，关键帧间隔 2 秒，写入 BT.709 色彩标记。

源像素仍然是 8-bit RGBA，和逐帧截 PNG 的做法一样。10-bit 的好处在于 YUV 转换和编码的精度，暗部渐变不容易出现色带。

本机 4K 测速（M4）：

| 环节 | 每帧耗时 |
|---|---:|
| `getImageData` 读回 RGBA（改用 P010 之前） | 约 23 ms |
| GPU 转 P010 后 `mapAsync` 读回 | 等 GPU 约 7 ms，复制约 1.7 ms，和下一帧的绘制重叠 |
| 异步 `VideoFrame.copyTo` 读回（试过，弃用） | 约 51 ms |
| ffmpeg 自身：管道 + 转换 + 编码 | 约 17 ms（上限约 57 fps） |

- **单个任务**：约 26–43 fps，瓶颈和并行的情况见下一节。

在一部实际的讲解动画上，与逐帧截屏导出的 10-bit 成片逐帧对比：SSIM 在一段 2D 段落为 0.998，在一段 3D 段落为 0.987；8-bit 时分别是 0.991 和 0.947。

### GPU 上转 P010

[page/gpu.mjs](page/gpu.mjs)：`copyExternalImageToTexture` 直接把合成用的 layoutsubtree 画布复制成 WebGPU 纹理（不再先复制到另一张输出画布，那一步只是 WebCodecs 需要），一个计算着色器每次处理 2×2 个像素，写出 4 个 Y 和 1 对 U、V，结果直接按 P010 的字节排布放在缓冲区里，`mapAsync` 读回。

- **换算**：和 ffmpeg 的转换（`scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=p010le`）相同：BT.709 矩阵、limited range，四舍五入到 10-bit。
  - 用 numpy 按公式算了一遍，GPU 的输出逐字节相同。
  - 纯色 (17, 34, 51) 转成 P010 后，按 BT.709、limited range 解码回到 (17, 34, 51)。不指定矩阵时，ffmpeg 按 BT.601 解码，得到偏暗的 (17, 33, 48)；早先观察到的"背景偏暗 2～3 级"就是这类解码设置造成的，不是导出偏差。
  - 和 ffmpeg 比：Y 有 98.75% 完全相同，其余差 1；色度在边缘有差别，因为 ffmpeg 的色度下采样用的是更宽的滤波器，这里是 2×2 平均。换算回 RGB 后，误差反而略小（平均 0.27 对 0.34）。
- **数据量**：每像素 3 字节，RGBA 是 4 字节。4K 一帧 25 MB，原来 33 MB。ffmpeg 也省掉了 CPU 上的颜色转换。
- **和下一帧重叠**：转换提交后立刻返回，读回在后台完成，页面同时画下一帧。三个读回缓冲区轮流用。
- **为什么用 WebGPU**：先试了 WebGL2。转换本身很快，但 `readPixels` 读 25 MB 要 14.5 ms 一帧，比 `getImageData` 读 33 MB（6.8 ms）还慢；改用 PBO 加 fence 异步读，也要 6.9 + 8.8 ms。WebGPU 的 `mapAsync` 读回约 1.7 ms，其余是等 GPU。
- **回退**：宿主在启动 ffmpeg 之前先让页面建好 WebGPU 设备。没有 WebGPU 时，打一行日志，改回读 RGBA、由 ffmpeg 转换，报告里 `readback` 为 `rgba`。环境变量 `WEBREEL_READBACK=rgba` 可以强制走老路，用于对比。
- **只用于 HEVC Main10**：ProRes 422 是 4:2:2，每像素也是 4 字节，读 RGBA 一样大；4444 和透明更大。这些仍然读 RGBA。
- **抽查**：抽查帧的 RGBA 也从这张纹理读出，所以比较的就是实际编码的那一帧。

### 重 WebGL 页面：时间花在哪（2026-10-16）

3D 测试页（three.js：4K 下开 MSAA，加 bloom 和两个后期通道，HTML 标注叠在上面）在 4K 10-bit 下约 27 fps。逐项拿掉合成步骤测速，每项 4 次取中位数：

| 拿掉的步骤 | fps |
|---|---:|
| 无（基线） | 27.2 |
| 复制到输出画布 | 27.9 |
| DOM 快照（`drawElementImage`） | 27.5 |
| 把 WebGL 画布画进合成画布 | 32.0 |
| 后两项都拿掉 | 34.1 |

- **复制到输出画布**：P010 时已经去掉，约快 3%。
- **画 WebGL 画布**：看起来占了约 18%，但拿掉的不只是这次绘制：没人读这个画布时，Chrome 很可能根本不执行它的渲染。
  - 换别的取法都一样慢：直接 `drawImage`、先 `createImageBitmap`、去掉 `drawMedia` 的裁剪。
  - **用 WebGPU 合成**：试过把 canvas 和 DOM 快照分别导入 WebGPU 再叠起来，结果和 2D 一样快（26–27 fps），所以没有保留。
    - `copyExternalImageToTexture` 直接读 WebGL 画布时，读到的是它上一次显示出来的画面。这个画布在快照里被挖掉，从不显示，所以画面一直停在第 0 帧，看起来"几乎不花时间"；
    - 先用 `createImageBitmap` 取到当前画面，结果正确，但速度和 2D 一样。
  - **结论**：剩下的时间是页面自己的 3D 渲染：4K MSAA，加 bloom 和两个后期通道。要更快只能让页面少画，比如降低 bloom 的分辨率，这是页面的事，不是导出器的事。

### 实际项目：一部 8 段的讲解动画（2026-10-16）

一部原本用逐帧截屏导出的讲解动画，8 段全部用 webreel 重新导出。配置：4K、60p、`--depth 10`，每轮 3 段并行。

- **用时**：共 33583 帧，用了 1514 秒（25 分钟）。原来的截屏流程也是每轮 3 段并行，按日志里每轮最长那一段估算，约 2943 秒（49 分钟）。
- **格式**：每段的格式和帧数都与原成片相同：Main 10、yuv420p10le、BT.709、60 fps。两段无损拼接后的那一段也一样。
- **画质**：与原成片同一时刻对比 SSIM。2D 段为 0.997～0.998，3D 段为 0.983～0.988。3D 的差异是贴图细节里的高频差别：模糊之后，平均差约 0.1。
- **文件大小**：同样是恒定质量 80，2D 段的文件约为原来的一半到三分之二，3D 段相差不到 3%。

### Chrome 子进程占住管道

Chrome 启动的 `chrome_crashpad_handler` 和 `GoogleUpdater` 会继承它的 stderr，并且比 Chrome 活得久。宿主退出前如果不主动关掉与 Chrome 相连的各条管道，node 会一直等这条 stderr 结束，进程就退不出来。这个问题在 3 个任务并行时出现过，所以现在 `finally` 里会逐个 `destroy()` 这些管道。

## 性能：瓶颈在哪，并行有没有用

2026-10-16 在 M4（10 核，16 GB）上拆开测过 4K 10-bit 的每个环节。

| 只测这一段 | 每秒帧数 |
|---|---:|
| ffmpeg：RGBA → P010 转换 + HEVC Main10 编码（node 一次写一整帧） | 57（开 3 个也合计 58，硬件编码器是共享的） |
| ffmpeg：只做转换 | 199 |
| 页面 → 宿主传输（不读像素、不编码） | 40 |
| 读像素：简单页面 / 3D 测试页（要等 GPU 画完 WebGL） | 7.5 ms / 22 ms 每帧 |
| 整条流水线：简单页面 / 3D 测试页 | 33 / 23 |

- **单任务的瓶颈是每帧 33 MB 的传输**。早先宿主把请求里的 64 KB 小块逐块写进管道，每块都等管道腾空（macOS 的管道缓冲只有 64 KB），这一段和 ffmpeg 互相拖慢，只有 31 fps。现在收齐整帧再一次写入，简单页面提到 33 fps；node 一次写一整帧时，管道本身能跑满 57 fps。
- **并行收益有限**。导出阶段的合计帧率：

  | | 1 个 | 2 个 | 3 个 |
  |---|---:|---:|---:|
  | 10-bit HEVC（3D 测试页） | 22.5 | 27.6 | 28 |
  | 8-bit HEVC（WebCodecs） | 38.4 | 45.8 | 33 |
  | ProRes 422 HQ | 22.0 | 26.4 | — |

  （这张表是改成 GPU 上转 P010 之前测的。）3 个并行时，物理内存 16 GB 用掉 14 GB，内存压缩约 2.8 GB，`kernel_task` 占 146% CPU；每个任务读像素和等待的时间都明显变长。共享的是内存带宽、GPU 和统一内存，多开 Chrome 只是在抢这些资源。
- **GPU 上转 P010 之后**（4K 10-bit，同一台机器，各跑 3 次）：

  | | 读 RGBA | GPU 转 P010 |
  |---|---:|---:|
  | 简单页面（clock-css） | 34–36 fps | 43–44 fps |
  | 3D 测试页 | 24 fps | 26.5 fps（去掉输出画布复制后 27–27.5） |
  | SVG 测试页 | 24.5 fps | 27 fps（去掉复制后 28） |
  | 4 段 4 秒素材，`batch` 2 个并行 | 39–45 s | 30 s |

  重 WebGL 的页面提升小，因为它们主要在等 GPU 把 WebGL 画完；并行时提升大，因为 ffmpeg 不再在 CPU 上转换，两个任务抢的内存带宽也少了。
- **结论**：不做"把一段切成几份并行"。它最多快 20% 左右，还要处理拼接和虚拟时钟重放。多段素材用 `webreel batch`，默认 2 个并行。同一部动画里的 4 段 5 秒素材（4K 10-bit）：串行 65 s，2 个并行 44 s，3 个并行 52 s。内存更大的机器可以试更高的 `--parallel`。

## 批量任务（`webreel batch`）

- **每个任务一个子进程**：就是 `render.mjs … --json`。某个页面卡死或崩溃，不影响其他任务。父进程按 `--parallel` 维持进程池，把子进程日志加上任务名前缀转出来，再收集每个任务的 JSON 结果。
- **启动前先验证**：每个任务的参数都先在父进程里用 `parse()` 检查一遍，包括输出文件是否已存在，有问题就一个都不启动。
- **单个任务失败不影响其他任务**：失败的任务带着错误代码列在结果里。退出码取第一个失败的类别。
- **拼接**（`concat`）：所有分段都成功后，用 ffmpeg 的 concat demuxer 无损拼接（`-c copy`），HEVC 加 `hvc1` 标记，并保留色彩标记。
  - 拼接前检查各段的尺寸、帧率、色深、透明通道和编码一致；
  - 拼接后数包，帧数必须等于各段之和，再写一份 `.json` 报告。
  - 每段都从关键帧开始（WebCodecs 和 VideoToolbox 都是第一帧为 IDR），所以可以直接拼。测试里 59.94 fps 拼接后的时间轴也是精确的。
- **停止时清理**：收到 SIGINT / SIGTERM / SIGHUP 时，单个导出会停掉 Chrome 和 ffmpeg，删除半成品和临时配置目录；批量任务会先通知每个子任务做同样的清理。
  - 这是一次事故后加的：父进程被 `kill` 后，子任务、Chrome 和 ffmpeg 还在继续跑，留下半成品文件。

## ProRes 输出（`--codec prores`）

WebCodecs 没有 ProRes 编码器，所以 ProRes 和 10-bit 走同一条路：页面读出 RGBA，宿主流式写进 ffmpeg。区别只在 ffmpeg 这一端：

- 编码器用 `prores_videotoolbox`（硬件编码），档位就是 `--prores`：proxy、lt、standard、hq、4444、xq，默认 hq。
- 转换和 10-bit 相同（BT.709、limited range），只是输出格式不同：422 档位转成 `p216le`，4444 / XQ 转成 `p416le`，带透明时转成 `ayuv64le`。
- ProRes 只有帧内编码，没有码率参数，所以 `--bitrate` 会报错。输出只能是 `.mov`。

本机测速（M4，ffmpeg 8.1.2，合成的 4K 测试图，纯 ffmpeg，不经过浏览器）：

| 编码器 | 422 HQ | 4444 |
|---|---:|---:|
| `prores_videotoolbox` | 124 fps | 59 fps |
| `prores_ks`（软件） | 18 fps | 18 fps |

硬件编码远快于读回，所以整个导出的速度和 10-bit 一样，取决于读回：4K 下 3D 测试页和 SVG 测试页都约 22 fps，透明测试页约 25 fps。软件编码器会成为瓶颈，所以没有用。

码率很高，并且随画面细节变化很大。4K 60p 实测：

| 页面 | 档位 | 码率 | 每分钟 |
|---|---|---:|---:|
| protocol 测试页 | 422 HQ | 0.36 Gbps | 2.7 GB |
| 透明测试页 | 4444 带透明 | 1.15 Gbps | 8.6 GB |
| SVG 测试页 | 4444 | 1.35 Gbps | 10 GB |
| 3D 测试页（贴图细节多） | 422 HQ | 1.78 Gbps | 13 GB |

## 透明通道（`--alpha`）

`--alpha` 输出 ProRes 4444（或 `--prores xq`），页面没有画东西的地方是透明的。需要改动的地方：

- **合成**：html-in-canvas 不填底色，只填页面自己的 body / html 背景；复制用的画布改成带 alpha 的，每帧先清空。WebGL / canvas 按自身透明度画在底层，和平时一样。
- **截屏**：用 `Emulation.setDefaultBackgroundColorOverride` 把浏览器默认的白底设成透明，截屏后备和抽查参照都是透明 PNG。实测 `optimizeForSpeed` 不影响 alpha。
- **读回**：`getImageData` 给出的是非预乘（straight）的 RGBA，ffmpeg 原样写进 alpha 平面，所以成片是 straight alpha。画布内部是预乘存储，透明度很低的像素颜色会有量化误差，透明度本身不受影响。
- **抽查**：只比较 RGB 会漏掉透明度错误。实测：把整张图的 alpha 丢掉、全部设成不透明，只看 RGB 的 SSIM 仍是 1.0000。所以带透明时，两边分别叠在黑底和白底上算 SSIM，取较差的结果：同样的错误，叠底后得分是 0.437 / 0.0004。
- **提醒**：第一帧完全不透明时，终端会提示页面自己画了背景。这种情况下透明通道全是 255，只是文件变大。

ProRes 4444 编码往返实测：alpha 误差在 1 级以内（8-bit 刻度）。测试页上空白处 alpha 为 0，55% 的卡片为 141，60% 的 WebGL 三角形为 154，颜色保持不预乘。

用 `renderAt(scene, t)` 的旧式页面里，`bg: 'none'` 的场景不加 `--alpha` 会报错，加了就能导出。这条路径还没有用真实页面测过。

## canvas / video 的样式

### 快照里的 canvas 内容

早先的结论是"快照里的 canvas / video 是空框"，这次复查发现并不准确。Chrome 155 的快照里会出现 WebGL 的内容，但是不完整：800×450 的画布只画出左上大约 80% 的区域，其余透明。而且它不受 `object-fit`、`object-position`、`object-view-box` 影响。所以没法让快照帮忙画内容，也没法只把内容"移出"内容区，只能用 `clip-path` 遮掉。

遮的方式是一个带洞的多边形（`evenodd`）：外圈取 ±100000 px，洞是内容区（按边框和内边距内缩），所以内容区以外的边框、轮廓、外阴影照常画。`clip-path` 以内联 `!important` 设置，导出结束后恢复页面原来的内联值。页面自己的 `clip-path`、`object-fit`、`object-position` 在设置之前读出并缓存，供绘制使用；不然读到的就是遮罩本身，内容会被裁没（实测过）。页面自己给 canvas 设了 `clip-path` 时，只能整个遮掉，这时 canvas 的边框和阴影会丢，所以这种组合会被判为无法重现。

### 绘制

每帧对每个 canvas / video，按 CSS 的顺序在底层重现：

1. **位置和缩放**：取元素的边框盒，把它到舞台之间所有元素的 `transform` 和 `scale` 缩放量连乘起来，得到元素本地 CSS 像素到输出像素的映射。用 `getBoundingClientRect` 的宽高除以缩放量得到本地尺寸，而不用取整的 `offsetWidth`。
2. **内容区**：边框盒按边框和内边距内缩，圆角半径也相应减小，内容裁剪在这个圆角矩形里。
3. **`object-fit` / `object-position`**：按 fill、contain、cover、none、scale-down 算出内容的绘制矩形。canvas 的固有尺寸是 `width` × `height`，video 是 `videoWidth` × `videoHeight`。
4. **`filter`**：Canvas 2D 的 `ctx.filter` 接受同样的写法，只把其中的 px 按输出缩放换算。CSS 规定滤镜先于 `clip-path` 生效，并且作用在圆角裁剪之后的内容上，所以有滤镜时，内容先画到一张临时画布上，再带着滤镜画回来。
5. **`clip-path`**：`inset`（含 `round`）、`circle`、`ellipse`、`polygon`、`path` 转成 `Path2D` 裁剪，参照框是边框盒。
6. **祖先的裁剪**：`overflow` 不是 `visible` 的祖先按它的内边距盒（含圆角）裁剪；祖先的 `clip-path` 同上。
7. **透明度和混合**：透明度为整条祖先链的乘积；`mix-blend-mode` 对应 `globalCompositeOperation`，两边的名字一一对应（`plus-lighter` 对应 `lighter`）。

### 无法重现的样式

导出前检查一次，每帧绘制时再查一次（只查 canvas 自身和祖先链，开销很小）：

- **导出前发现**：改用截屏方式。
- **导出中途才出现**：导出报错，提示改用 `--capture screenshot`。

无法重现的样式：

- 元素或祖先：`mask`、旋转、斜切、3D 变换、负缩放（镜像翻转）、`clip-path: url()` 或其他无法解析的写法；
- 祖先：`filter`、`mix-blend-mode`；
- 元素自身：背景图片、内阴影、SVG 滤镜、`plus-darker` 混合，以及 `clip-path` 和边框 / 轮廓 / 阴影同时出现；
- 任何与 canvas 重叠、带 `backdrop-filter` 的元素。快照看不到下面的 canvas，模糊不到它的内容。这一项要遍历整个舞台，所以只在导出前检查。

### 测试页的结果

[test/fixtures/media-styles.html](test/fixtures/media-styles.html) 把上面能重现的样式都用上了，包括一段视频。[test/fixtures/media-fallback.html](test/fixtures/media-fallback.html) 有 4 种无法重现的情况，用 `--q case=…` 选择。

| 页面 | 上一版 | 现在 |
|---|---|---|
| media-styles | 抽查失败：整帧 0.82，最差区块 0.28 | 通过：整帧 0.999，最差区块 0.97 |
| backdrop（毛玻璃盖在 WebGL 上） | 抽查失败：最差区块 0.887 | 导出前检测到，改用截屏 |
| mask | 抽查失败：最差区块 0.42 | 同上 |
| mirror（`scaleX(-1)`） | 抽查失败：最差区块 0.81 | 同上 |
| parent-filter（外层 `blur(2px)`） | **抽查通过，交出了没有模糊的画面** | 同上 |

最后一行说明抽查不能代替检测：2 px 的模糊在 SSIM 上几乎看不出来。

现在剩下的差异在视频上。同一段视频，`drawImage` 读到的颜色和浏览器合成显示的颜色不一样：testsrc2 的红条，快速方式是 (230, 0, 0)，截屏是 (248, 35, 0)，源是 (254, 0, 0)，两者都不等于源。测试页因此改用黑白视频，只验证几何。哪一种颜色更准还没有查清。

## 截屏后备

`--capture auto` 在正式导出前，先用第一帧检查页面能不能合成。不能时改为每帧调用 `Page.captureScreenshot`，在页面里解码，再用 WebCodecs 编码（10-bit、ProRes 时交给 ffmpeg）。检查的内容：

- **有没有东西盖在 canvas / video 上**：只画 DOM 快照，看 canvas / video 所在区域，超过一半的采样点不透明，就认为被盖住了。
- **canvas / video 的样式能否重现**：见上一节"无法重现的样式"。
- **浏览器是否支持**：`drawElementImage` 是否存在。

## 虚拟时钟

页面加载完成后，宿主最多等 `--wait` 秒（默认 2 秒），看页面会不会出现 `window.webreel`、`window.film` 或 `renderAt`。如果没有出现，就用 `Page.addScriptToEvaluateOnNewDocument` 注入 [page/clock.js](page/clock.js)，再重新加载页面。

- **替换的接口**：`performance.now()`、`Date`（不带参数构造、`Date.now()`、直接调用 `Date()`）、`requestAnimationFrame` / `cancelAnimationFrame`、`setTimeout` / `setInterval` / `clear*`。导出器自己用的是替换前保存下来的真实版本（`__webreelClock.real`）。
- **加载阶段**：页面时间停在 0。0 延迟的计时器仍然会通过真实的事件循环分批执行，因为启动代码常这样延后初始化；`requestAnimationFrame` 回调不执行。
- **seek(t)**：每次前进 1/fps，越过的计时器按到期顺序执行，每个回调看到的是自己的到期时间；然后执行一批 `requestAnimationFrame` 回调；每一步之间让出一次真实的宏任务，让 Promise 链跑完。
- **CSS 动画、过渡和 Web Animations**：它们跑在真实的文档时间轴上，所以按"第一次看到它时的虚拟时间"记下起点，每帧暂停后把 `currentTime` 设为 (虚拟时间 − 起点) × playbackRate。到达终点时调用 `finish()`，而不是停在终点，这样 `animationend` / `finish` 事件照常触发。页面自己暂停的动画不去动。
- **DOM 移动**：把页面移进画布、再移回来时，浏览器会重启 CSS 动画。`preserve()` 按"元素 + 动画名"（过渡用"元素 + 属性名"）把原来的起点接到新的动画对象上。
- **只能前进**：`--start S` 会先从 0 逐帧重放到 S。抽查时参照帧不能倒回去取，于是宿主重新加载页面，从 0 重放到每个抽查时刻再截屏；导出时保留的原始 RGBA 帧暂存在宿主那边。
- **时长推算**：只有当前没有 `requestAnimationFrame` 回调和待执行的计时器，并且所有动画都是有限次时，才取最晚的结束时间；否则要求传 `--duration`。

没有采用 CDP 的 `Emulation.setVirtualTimePolicy`，因为在 Chrome 155 新 headless 模式下实测有两个问题：

- 推进几步之后，CSS 动画就停在 1000 ms，`requestAnimationFrame` 也不再执行，而 `performance.now()` 已经走到 2100 ms；
- 时间暂停期间，`requestPaint` 的 paint 事件和 `Page.captureScreenshot` 都会卡住。

## 抽查

在 `--check N` 个均匀分布的帧上，比较导出画面和浏览器正常显示的截图：

- **`window.webreel` 页面**：导出结束后，把页面恢复原样，调用 `frame(t)` 再截屏。
- **虚拟时钟页面**：在一次全新加载中重放到同一时刻，再截屏。

两者计算亮度 SSIM，阈值是：

- 整帧均值 ≥ `--check-min`（默认 0.98）；
- 最差的 128×128 区块 ≥ `--check-tile`（默认 0.90）。

只看整帧均值不够。`test/fixtures/selector.html` 用 `body > .title` 定位标题，页面移进画布后选择器不再匹配：整帧 SSIM 仍有 0.980，最差区块只有 0.49。

抽查失败时导出报错。MP4 一直停在临时文件里，宿主不会改名，所以不会留下错误的视频。截屏方式不抽查，因为它本身就是参照。

## 面向 agent 的命令行约定

主要使用者是 agent，所以命令行按"调用一次、读一个结果"设计：

- **`--json`**：stdout 上只有一个 JSON 对象，进度和日志全部走 stderr（宿主里的 `say`）。成功时是报告本身加 `ok: true`，失败时是 `{ ok: false, error: { code, message, hint } }`。
- **错误代码**：每个可预期的失败都有固定的代码和下一步建议，退出码按类别分组（2 参数、3 页面、4 画面不一致、5 环境、1 其他），见 render.mjs 里的 `EXIT`。
  - 页面里抛出的错误带 `code` / `hint` 属性（export.mjs 的 `fail`）。
  - 宿主调用页面入口时，用 `callPage` 包一层：在页面里捕获异常，把这三项作为返回值带回来。CDP 只返回异常的描述文字，所以不能直接靠异常传递。
  - 宿主的 HTTP 端点出错时（比如 ffmpeg 写不进去），页面看到的只是一个 500。所以 `callPage` 优先抛出宿主记下的那个原始错误。
- **抽查由宿主判定**：页面只返回每帧的分数和 `pass`。`render` 有任何一帧不通过就报 `CHECK_FAILED`，`check` 则把结果和建议一起报告，自己不算失败。
- **ffmpeg 预检**：需要 ffmpeg 时，启动 Chrome 之前先运行 `ffmpeg -encoders`，确认有对应的 VideoToolbox 编码器，缺了就立即报 `FFMPEG`。

### `webreel check`

导出的流程去掉编码：

1. 加载页面，必要时改用虚拟时钟。
2. 准备阶段遇到推算不出的长度时，不报错，而是返回 `duration: null` 和原因。
3. 按导出时的规则选择抓帧方式。
4. 在检查时刻画出这几帧，用 `convertToBlob` 存成 PNG，发给宿主写盘。
5. 和导出一样与截屏比较；虚拟时钟页面同样要重新加载、重放到这些时刻再比较。

检查时刻对齐到帧网格，默认取第一帧、中间一帧、最后一帧；长度未知时只取第一帧。输出里的 `hints` 汇总了需要处理的事：缺长度、会改用截屏、抽查不通过、WebGL 是软件渲染。

## 输出安全

- **源文件只读**：HTTP 服务只读地提供 `--root` 目录，只在内存里给页面 HTML 插入导出模块，不改源文件。
- **写入过程**：先写到同目录下的 `.<name>.<uuid>.partial`，抽查通过后才改名。目标文件已存在时，必须显式传 `--overwrite`。
- **隔离**：Chrome 使用临时配置目录，退出后删除。

## 实测数据

2026-10-16，Apple M4，Chrome 155，1080p，59.94 fps，H.264，24 Mbps。

- **导出阶段**：从页面准备完成算到编码结束。
- **全程**：另外包括启动 Chrome、加载页面和 3 帧抽查。

| 页面 | 帧数 | 逐帧截屏（默认节流） | 截屏（去节流） | 上一版 WebCodecs | webreel 导出阶段 | webreel 全程 |
|---|---:|---:|---:|---:|---:|---:|
| 3D 测试页 6–8 s（three.js + HTML 标注） | 120 | 14.7 s | 10.7 s | 2.6 s | 2.9 s | 4.2 s |
| SVG 测试页 10–15 s | 300 | 14.7 s | 7.3 s | 3.6 s | 3.6 s | 4.6 s |

- **测法**：
  - 逐帧截屏：CDP 截 PNG，再用 ffmpeg 的 VideoToolbox 编码。它和 Main10 / ProRes 成片配置不是严格的同条件对比。
  - "截屏（去节流）"和"上一版 WebCodecs"：各跑三次，波动在 2% 以内。
  - webreel：来自一次回归运行。机器负载高的时候，3D 测试页曾经测到 4.4 秒，空闲时重跑在 2.8～3.2 秒之间。
- **画质**：编码后与截屏基线的 SSIM，3D 测试页为 0.985，SVG 测试页为 0.997，和上一版相同。抽查帧的整帧 SSIM 在 0.999 以上。
- **瓶颈**：两条快路径的大部分时间都在等编码和 GPU 队列（约 2.2 秒），抓帧已经不是瓶颈。html-in-canvas 带来的是通用性，不是额外的速度。
- **去节流的效果**：截屏方式在 SVG 页面上快了约 2 倍；在 WebGL 很重的页面上帮助很小。
- **虚拟时钟页面**：每次多花 1～2 秒，用在加载后的检测等待和两次额外的页面加载上。

## 测试

```bash
sh test/fixtures.sh
```

- **fixtures.sh**：48 项检查，用 [test/fixtures/](test/fixtures/) 里的测试页面，覆盖：
  - `window.webreel` 页面（1280×720，WebGL 在 DOM 下）及其 2 倍输出；旧名 `window.film` 仍被识别；
  - 截屏后备，以及 `--capture hic` 在同样情况下报错；
  - 抽查失败时不留下文件；
  - 三种虚拟时钟页面：CSS 关键帧、带状态的 rAF + 计时器、补间引擎 + Web Animations；
  - CSS 动画的位置随帧时间变化（逐帧测红块位置）；
  - rAF 页面缺 `--duration` 时报错；
  - 10-bit 和 ProRes 422 HQ 的流格式（ffprobe）；10-bit 走 GPU 转 P010，和 ffmpeg 转换的结果比 SSIM；没有 WebGPU 时退回读 RGBA；
  - `--alpha`：两种抓帧方式下，透明测试页的空白、半透明卡片和 WebGL 三角形的 alpha 值；页面自带背景时的提醒；HEVC 加 `--alpha` 报错；
  - 不加 `--alpha` 时，没写背景的页面按白底导出，抽查通过；
  - canvas / video 的样式按快速方式重现并通过抽查；4 种无法重现的情况改用截屏；
  - `--json` 的成功结果和错误（代码、建议、退出码）；`check` 的长度推算、静帧、改用截屏的原因，以及抽查不通过时只报告、不失败；
  - `batch`：进程池、单个任务失败不影响其他任务、59.94 fps 的 10-bit 无损拼接（时间轴和色彩标记），以及启动前发现输出已存在。
- **verify.py** 检查的内容：帧数、分数帧率、逐帧 PTS / DTS、首帧是关键帧、完整解码；带 `--reference` 时还比较编码后的 SSIM。

**升级 Chrome 之后要重跑**，因为 html-in-canvas 是要用启动参数打开的实验接口。
