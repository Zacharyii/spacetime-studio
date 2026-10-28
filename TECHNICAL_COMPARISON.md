# 时空可视化参考项目技术评估

评估日期：2026-10-26。范围：阅读四个仓库的 README 与可获取的核心源码，再与当前 Space-Time Studio 实际代码和阶段 0/1 的运行结果比较。以下许可证判断是对仓库当前可见文件的核对，不构成法律意见。

## 结论

**继续完善现有项目；不重写整个应用，也不替换阶段 1 渲染器。** 当前的 React / Three.js、FastAPI / OpenCV、FFmpeg 职责划分符合本项目的离线目标，固定机位背景差分、可旋转时间平面栈和逐帧 MP4 导出均已实际跑通。保留平面栈作为可验证基线；未来可把“GPU 3D 纹理 + shader 体渲染”作为独立实验渲染器评估。只有性能或视觉测试证明平面栈达不到目标，再替换渲染实现。

Louis 项目最值得借鉴的是**像素级的时间变化分析与体积渲染思路**，不是必须照搬其代码结构。它比当前项目更接近“整个视频就是一个 x-y-t 体积”的完整模型；当前项目的前景蒙版与局部处理流程则更直接符合第一版“固定机位运动主体轨迹”的验收目标。

## 项目逐项核对

| 项目 | 时空体生成与渲染 | 差分、运动轨迹 | 镜头与导出 | 许可证核对 |
|---|---|---|---|---|
| [louisbarrett/timecube](https://github.com/louisbarrett/timecube) | 浏览器 WebGL2；每帧写入 RGBA 3D 视频纹理，另有一张 stain 3D 纹理；以 ray marching 盒体渲染，按时间层采样以保留切片边界。README 还说明通过 ring buffer 回收实时视频的旧层。 | stain pass 可比较前一层、首层、相邻层或运行均值；维护 running mean 与衰减 peak，支持 background subtract、persistence、flow、novelty 等规则。相较单一帧差，表现形式更丰富，也能构造更有方向性的轨迹。 | 相机可 orbit / pan / zoom；支持时间切片播放、PNG 与 canvas 录制，并声明完整 peel 可逐层离线渲染。浏览器录制的格式/稳定性仍应按目标浏览器单独验证。 | 仓库顶层文件列表未显示 LICENSE，README 也未声明代码许可证。按无明确授权处理：仅参考公开技术思想，不复制代码或 shader。 |
| [Babad88k/FrameCube](https://github.com/Babad88k/FrameCube) | React Three Fiber / Three.js；README 的主视图为半透明时间平面，也提供按像素建立的点云视图，并以 luminance threshold 控制点显示。源码位于仓库内 `FrameCube.zip`。 | 不以背景差分为主。点云模式把像素颜色、位置和帧索引组成一份几何数据；播放头附近的历史/未来帧可调整透明度。更偏向将像素体素化的表现。 | OrbitControls；README 设定短片与较低分辨率预算（约 5 秒、12 FPS、长边 128 px、约 60 帧）；导出是 PNG sprite sheet，而非 MP4。 | 仓库顶层及打包源码中未找到 LICENSE 或明确授权声明。仅借鉴采样预算、平面/点云双模式的产品思路，不复制实现。 |
| [yitzilitt/TIMECUBE](https://github.com/yitzilitt/TIMECUBE) | Three.js 点云与 PLY 数据管线；TIMEKNIFE 用任意方向平面查看体数据。README 当前列出的导入格式是 `.ply` / `.timecube`。 | 可调整透明度、点大小等；不是当前目标中“从普通视频自动估计固定背景并提取主体”的完整处理流程。README 将 MP4 转换列为 coming soon。 | OrbitControls / 切片交互；README 提到切片动画导出为未公开功能。因此主要价值是任意斜切截面这一交互概念，而不是已验证的视频导出方案。 | 仓库文件列表未发现 LICENSE，README 未声明授权。仅借鉴 TIMEKNIFE 与斜切面的产品概念，不复制代码。 |
| [nikfilippas/timecube](https://github.com/nikfilippas/timecube) | 原生 Qt / OpenGL / FFmpeg；后台渐进解码并构建 GPU 常驻 3D 纹理，避免先把长视频全部解码到 CPU 后才可交互。 | 支持平行时间切片、运动加权 trails 与透明度控制；文档称可渐进构建体积，而不是背景分割器。 | 四元数 virtual trackball、任意斜切、播放/逐帧/时间轴、截图导出。README 给出 512 px 空间边长、768 时间层默认预算；更高密度示例要求 768/1024，低显存示例为 384/512。安装说明针对 Ubuntu，未核实 macOS 支持。 | GitHub 标记 GPL-3.0 且根目录含 LICENSE。可以在遵守 GPL 的前提下使用其代码，但本项目当前只提取一般架构启发，不引入其代码。 |

Louis 的 README 明确说明项目受 Instagram 创作者 @btangonan 发布的 demo 启发，同时声明其实现是独立重建，而非复制创作者未公开的代码；这正对应本项目参考目标。README 也对两张 3D 纹理、stain pass、ray marching、时间采样和导出行为有直接说明；核心源码 `src/core/volume.ts`、`src/core/stain.ts`、`src/shaders/stain.frag.glsl`、`src/shaders/raymarch.frag.glsl`、`src/core/ingest.ts` 和 `src/core/recorder.ts` 已核查。FrameCube 的源码在 zip 中；重点检查了 `extract-frames.ts`、`frame-cube-scene.tsx` 与 `export-sheet.ts`。TIMECUBE 的 `timecube_slicer.js` / `main.js` 与 nikfilippas 项目的 `src/main.cpp` 也作为实现形态参考。无许可证的项目不复制实现代码。

## 与当前项目的差异

| 方面 | 当前 Space-Time Studio | 评估与差距 |
|---|---|---|
| 帧采样 | FFmpeg 按 5 / 10 / 15 FPS 抽样；预览宽度最多 640 px；最多 150 帧。 | 固定间隔的原型已运行，但尚未覆盖可变帧率时间戳、旋转元数据等边界案例。 |
| 背景差分 | OpenCV 对采样帧取时间中位数作为静态背景，阈值分割、形态学开闭、连通域过滤和 Gaussian 羽化；保留原帧 RGB、写入 alpha。 | 这是阶段 1 已实现的核心。适合静态机位，不含光流、渐进背景或动态机位补偿。 |
| 3D 结构 | 每个采样帧是独立 `PlaneGeometry + MeshBasicMaterial + Texture`，按 `z = (i - (N-1)/2) * spacing` 放置。主体模式纹理背景透明。 | 三维效果成立且鼠标可 orbit；当前仍是平面栈，不是单个 3D 纹理/点云体，也没有任意角度切片或时间播放头。 |
| 相机 | Three.js `OrbitControls` 支持旋转、缩放、平移；另有 Orbit / Fly-through / Side Reveal 三种预设。 | 支持由确定性 `cameraPoseAt(t)` 驱动的播放、暂停、循环、进度定位和复位；预览与导出共用相机渲染函数。 |
| 处理架构 | 本机 FastAPI 接收文件，FFmpeg 抽帧，OpenCV 生成 PNG；React/Three.js 读取本地 API 返回的帧。监听回环地址。 | 符合既定后端技术栈；比纯浏览器方案多一个本地服务，但对后续逐帧 FFmpeg 编码自然。运行时无需云服务。 |
| 视频导出 | 浏览器 WebGL 逐帧输出 PNG，FastAPI 分批接收后由本机 FFmpeg 编码。支持 9:16 / 16:9、720p / 1080p、30fps H.264 yuv420p、进度、取消和下载。 | 两种画幅均已有实际 1080p 成片，并用 ffprobe 检查；PNG 批次上传避免将整段高分辨率帧常驻内存。视频不带音频。 |
| 资源释放 | 重建或卸载时 dispose 纹理、材质和几何；有当前处理帧数及 RGBA 纹理估算。 | 已有基本释放与诊断；尚未做连续多素材压力或 24GB 目标机实测。FPS 数值已在当前 Chromium 实际页面显示约 60；不同设备仍需实测。 |

本机合成素材为 5 秒、640×360、30 FPS，按 10 FPS 得到 50 帧；API 返回 `frameCount=50`，前景面积约占 1.57%，主体轨迹可旋转观察。阶段 2 对同一素材生成了 1080×1920 与 1920×1080、各 5 秒 150 帧的 H.264 / yuv420p / 30fps 视频。抽取并检查开头、中段和末尾，均能辨认连续轨迹且没有裁切；前后端测试及浏览器取消流程已通过。证据与限制详见 `PROGRESS.md`。这不等于验证真实人像质量或 M5 设备持续性能。

## 值得借鉴与已具备能力

**继续保留：**

- 固定机位视频的时间中位数背景模型和透明前景 alpha；这是当前产品要求的首个可靠路径。
- 可旋转平面栈作为渲染基线，便于观察遮挡、透明混合和轨迹形态，代码简单、便于调试。
- 帧数、分辨率和时间长度上限；后台抽帧；GPU 资源显式释放。

**下一步可吸收的技术思路：**

1. **确定性相机轨迹已实现。** 三个预设由归一化时间 `u ∈ [0,1]` 计算位置与朝向；预览时间轴和逐帧导出共用 `renderFrame(t)`，动画不依赖浏览器实际 FPS。
2. **逐帧导出与编码已实现并验收。** 从正在工作的 WebGL canvas 读取 PNG，分批交给本机 FFmpeg 编码 H.264；两种画幅都核对了尺寸、FPS、色彩格式、时长及抽帧画面。
3. **在独立渲染器原型中评估 GPU 体纹理。** 参考 Louis 的“一帧一层”3D 纹理、增量 stain 与时间轴对齐采样，比较画质、内存、帧时间和导出一致性后再决定是否替换平面栈。
4. **将算法选择明确分层。** 固定背景差分用于当前主模式；running mean / decayed peak / motion-weighted trail 作为之后可选分析模式。Lucas–Kanade 等局部光流只在真实片段证明增益后再加。
5. **导入与视图解耦。** 参考 FrameCube 的 planes/point-cloud 对照方式，未来可增加点云/采样降阶视图，但需先证明其在“移动主体轨迹”上优于透明平面。
6. **借鉴渐进加载但不照搬平台。** 长片分段抽样、逐步补齐体纹理可避免界面等待；nikfilippas 项目的 GPU 常驻、后台构造值得作为性能目标，Qt/Linux 架构并不适合直接搬进当前浏览器应用。

已实现的能力包括：MP4/MOV/M4V 本地导入、ffprobe 元数据、起止范围、5/10/15 FPS、150 帧限制、时间中位数背景差分、阈值/羽化/形态学参数、完整帧对照、按 Z 时间映射、可旋转/缩放/平移和视角复位、背景/网格开关、资源 dispose、处理帧数与 RGBA 内存估算。三个确定性相机预设、播放/暂停/循环/定位、H.264 MP4 两种画幅导出、进度/取消、JSON 参数预设均已实现。批量队列未实现，且按优先级暂不启动。

## MacBook Air M5 / 24GB 运行可行性

**可行性判断：**当前运行主机已确认是 MacBook Air M5 / 24 GB。5 秒用户素材片段（50 张预览切片）处理约 2.2 秒；随后 720p 与 1080p、各 150 帧视频导出均约 3–4 秒完成。1080p 样片经 `ffprobe` 验证为 H.264 / yuv420p / 30 FPS / 5 秒。当前预览纹理预算为 138.9 MiB。结果表明短片单路导出可行，但浏览器交互墙钟时间不是隔离性能测试，也没有测峰值内存、温升、长时间降频或更长片段。

当前 UI 的 RGBA 纹理估算为 `宽 × 高 × 4 × 帧数`：

- 640×360×50 ≈ **43.9 MiB**；
- 640×360×150 ≈ **131.8 MiB**；
- 1280×720×150 ≈ **527.3 MiB**；
- 1920×1080×150 ≈ **1.16 GiB**。

当前预览采样最大宽度是 640 px，故 720p/1080p 的数字只是用于评估未来高质量导出纹理预算。实际还包括 PNG 解码、浏览器副本、场景纹理、CPU 的 `np.stack` 临时背景计算、编码缓冲和桌面系统内存。主体与完整帧图片均由后端写入磁盘，但同一时刻前端只载入当前模式的一组纹理。

若采用 Louis 式视频纹理 + stain 纹理，RGBA 两张体纹理的基础显存约为上表的 2 倍（例如 640×360×50 约 **87.9 MiB**），另有运行统计、渲染目标和累积缓冲。每个输出像素每帧还需多次 shader 采样；其占用并非简单地比当前方案低。需要遵守 WebGL 3D 纹理维度限制，并将预览分辨率、帧数和逐帧输出缓冲分开控制。

性能优化顺序建议：固定预览宽度/总像素预算；避免 CPU 同时持有原始帧、透明帧和完整帧的大数组；逐批上传、尽快释放解码对象；共用平面几何（如验证可行）或图集减少 draw call；帧数过多时降低采样率；导出逐帧渲染、单路编码，不把全部高分辨率 RGBA 帧常驻内存。后续在 M5 Air 上记录 720p 预览 FPS、处理峰值内存、5–10 秒 MP4 导出时间和长时间负载温度。无风扇机型长时间渲染应允许降速或暂停，不以短片耗时推断持续性能。

## 许可证与代码复用边界

截至评估日期，GitHub 仓库元数据对 Louis、FrameCube、yitzilitt 三个项目返回 `license=null`，根目录文件清单也未显示 LICENSE，README 未声明授权条款；应按“无明确许可证”处理。GitHub 说明未附许可证时默认版权规则仍适用（[GitHub 许可证说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)）。GitHub 公开可见不等于获准复制、改编或再分发代码。可以借鉴通用技术思想，但本项目不会粘贴其源文件、shader、算法实现细节或大段界面代码。nikfilippas/timecube 使用 GPL-3.0；如未来需要直接采用代码，必须单独评估 GPL 对分发和衍生作品的要求，当前不复制。

## 开发决策

1. 维持现有前后端、API 与前景帧格式；当前镜头与导出已建立在已验证渲染器上。
2. 阶段 2 两种比例成片已完成机器与人工帧检查；下一步先验证真实固定机位素材和目标 M5 Air 性能。
3. 暂不启动批量系统；优先根据实测瓶颈改进主体分割、GPU 资源或单视频导出。
4. 保留已显示的渲染 FPS 诊断，并在目标 M5 Air 上记录持续帧率。
5. 单独做体积 renderer 的可切换实验，使用同一合成素材做视觉/内存/性能 A/B；除非有测量结果支持，否则不替换现有实现。

## 参考资料

- [louisbarrett/timecube README（含 @btangonan 来源说明）](https://github.com/louisbarrett/timecube#credit)；[README 技术说明](https://github.com/louisbarrett/timecube#how-it-works)；[volume.ts](https://github.com/louisbarrett/timecube/blob/main/src/core/volume.ts)、[stain.frag.glsl](https://github.com/louisbarrett/timecube/blob/main/src/shaders/stain.frag.glsl)、[raymarch.frag.glsl](https://github.com/louisbarrett/timecube/blob/main/src/shaders/raymarch.frag.glsl)
- [FrameCube README 与仓库文件](https://github.com/Babad88k/FrameCube)
- [yitzilitt/TIMECUBE README](https://github.com/yitzilitt/TIMECUBE#readme)；[timecube_slicer.js](https://github.com/yitzilitt/TIMECUBE/blob/master/timecube_slicer.js)
- [nikfilippas/timecube README](https://github.com/nikfilippas/timecube#readme)；[main.cpp](https://github.com/nikfilippas/timecube/blob/main/src/main.cpp)、[GPL-3.0 LICENSE](https://github.com/nikfilippas/timecube/blob/main/LICENSE)
