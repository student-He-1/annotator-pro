# NEXT.md — 下一步开发交接

> 这个文件是给「下一次对话的开发者（AI / 我自己）」看的快速上手笔记。
> 项目正式说明见 [README.md](./README.md) 与 [开发说明日志.md](./开发说明日志.md)。

---

## 2.0 版本完成（2026-09-20）：SAM 重构为 Python GPU 后端

**核心改动：** 把浏览器端 ONNX Runtime 推理（纯 CPU wasm，15秒/张，结果垃圾）完全推翻，改成 Python FastAPI + PyTorch + CUDA GPU 推理。

**架构：**
```
前端 Svelte → fetch http://127.0.0.1:1421 → Python FastAPI → PyTorch + CUDA → SAM 3
```

**性能对比：**
| 阶段 | 1.0（浏览器 wasm） | 2.0（Python GPU） | 提升 |
|------|-------------------|-------------------|------|
| 图片编码 | ~15 秒 | ~1.3 秒 | 11x |
| 点预测 | ~1 秒+ | ~10 毫秒 | 100x |
| 分割质量 | fp16 NaN 垃圾值 | 完美（score 0.977） | 质变 |

**改动的文件：**
| 文件 | 内容 |
|------|------|
| `python/sam_server.py`（新增） | FastAPI 服务，SAM 3 GPU 推理 |
| `src/lib/sam.ts`（重写） | 从 onnxruntime-web 改成 fetch 调用 Python |
| `src/components/SamModelModal.svelte`（改） | 从"上传 onnx 文件"改成"连接后端服务" |

**没动的文件：**
- Canvas.svelte — 画布交互、坐标转换完全保留
- 标注管理、导入导出、YOLO、魔术棒 — 全部原样

**环境信息：**
- Python 虚拟环境：`D:\79458\Documents\anaconda3\envs\deeplearning`
- Python 3.9.25 + PyTorch 2.8.0+cu128
- GPU：RTX 4050 Laptop（6GB 显存）
- 模型：`E:\Doubao download\sam3.pt`（3.21 GB）
- 后端端口：1421（前端 1420）

---

## 2.1 计划：接下来要做什么

**PVS（点提示分割）已完成，接下来做：**

1. **PCS 文本提示分割** — 输入类别名称（"猫"、"狗"），自动找到所有匹配实例
2. **框提示分割** — 画框，分割框内物体
3. **姿态关键点预标注** — 人体/手部关键点自动标注（参考 LabelPaw）

当前 2.0 版本只支持点提示分割（PVS），文本提示（PCS）和框提示还没接。

---

## ⚠️ 以下为 1.0 版本历史（已废弃，仅留作参考）

> 2.0 版本已完全推翻浏览器 ONNX Runtime 方案，改用 Python GPU 后端。
> 下面的内容仅作历史记录，不要再按这个方向开发。

---

## 已完成（2026-09-20）：SAM 提速 + 参数闭环 + 打包修复

改动的文件：

| 文件 | 内容 |
| --- | --- |
| `src/lib/ortRuntime.ts`（新增） | ORT 统一运行时：webgpu 构建、wasm 资源用 `?url` 导入、优先申请高性能适配器 |
| `src/vite-env.d.ts`（新增） | 让 TS 认识 Vite 的 `?url` 导入 |
| `src/lib/sam.ts` | 打开 GPU EP（`['webgpu','wasm']`，带 CPU 回退）、去掉无效参数、加 prompt 记忆/重跑/耗时统计 |
| `src/lib/yolo.ts` | 改用同一个运行时（修掉同款路径 bug），EP 仍是 `wasm`（未动已验证行为） |
| `src/lib/state.svelte.ts` | 移除 `samMultiMask`（假开关） |
| `src/components/SamModelModal.svelte` | 推理后端/耗时/候选数回显、恢复默认、按当前参数重跑 |
| `src/components/Canvas.svelte` | 配置对象去掉 `multiMask` |
| `vite.config.ts` | 删掉失效的 `manualChunks`（改动态导入后已在报 empty chunk） |

关键结论：

- **以前根本没开 GPU**：EP 一直硬编码 `['wasm']`。
- **打包后原本加载不了模型**：`wasmPaths` 写死 `/node_modules/onnxruntime-web/dist/`，dev 能过，exe 里 404。
- **mask 坐标系是对的**（用合成图实测验证，见下），"框不准"不是坐标错位。

---

## 当前 SAM 实现现状（不要从零开始写）

代码在 `src/lib/sam.ts`，标准双文件 ONNX 格式：

- 能力：point prompt（正/负点）、box prompt、mask → 多边形（复用 `magicwand.ts` 的 `extractContour/simplifyPolygon`）。
- `SamConfig`：`encoderInputSize`(1024) / `maskThreshold`(对 logits，默认 0) / `simplifyTolerance`(默认 1.0)。
- 弹窗：`src/components/SamModelModal.svelte`。「按当前参数重跑」依赖 `sam.ts` 里记住的 `lastPrompt`（按 `image.src` 校验图片是否已更换）。

### 实测的模型接口（E:\Doubao download 里的两个文件）

```
encoder:  input_image      f32 [1,3,1024,1024]
          → image_embeddings f32 [1,256,64,64]（fp16 权重，I/O 仍是 f32，opset 17 / IR 8）

decoder:  image_embeddings [1,256,64,64] + point_coords + point_labels
          + mask_input [1,1,256,256] + has_mask_input [1] + orig_im_size [2]
          → masks [1,1,H,W]（H,W = 原图尺寸）+ iou_predictions [1,1] + low_res_masks [1,1,256,256]
```

- 现有 `sam.ts` 的输入名自动匹配逻辑跟这套命名是对得上的。
- **`iou_predictions` 只有 1 个候选**，所以没有"三选一"，单点提示容易咬到局部区域。
- **`masks` 已经被 `orig_im_size` 插值回原图尺寸**，所以多边形**不需要**做 scale/pad 逆变换。
  换 SAM2/SAM3 的导出后必须重新确认这一条，别硬套。

### 性能实测（Python ORT / CPU，合成图 800×600）

| 阶段 | 耗时 |
| --- | --- |
| encoder | **6.61 s / 张**（每换一张图跑一次，有缓存） |
| decoder | **42 ms / 次点击** |

慢的原因之一是 **fp16 encoder 在 CPU 上要被 cast 回 f32**，日志会刷 `Could not find a CPU kernel ... Div`。
已改成 `['webgpu','wasm']`，**需要在真机上复测编码耗时**：降到 0.2~1s 说明 GPU 生效；仍是 6s 说明 fp16 没跑通 WebGPU，得换 fp32 encoder（375MB）。

---

## 下一步：接入 SAM3 的计划

### 先理解 SAM3 是两套东西（接口"不一致"的根因）

- **PVS（Sam3Tracker）**：点/框/掩码 → 单个物体掩码。官方说明它是 SAM2 的更新版、**保持 SAM2 的 API**，可当 SAM2 工作流直接替换。**这才是现有"点选"工具该接的东西。**
- **PCS**：文本短语 / 示例框 → 图里**所有**匹配实例 + 实例 ID。架构是 DETR 检测器 + presence head + 共享 PE 视觉骨干，**没有** encoder/prompt_encoder/mask_decoder 三段式，也不接受"一个点出一张 mask"。这是**新功能**，不是升级。

### 体积账（决定方案可行性）

| 方案 | 规模 |
| --- | --- |
| MobileSAM / SAM1 ViT-B | ~40MB / 375MB（fp16 版 171MB） |
| SAM2.1 Hiera-Tiny | ~78MB |
| SAM3 全量 | ~3.45GB（473.6M 参数，PE-ViT-L+ 骨干 446M） |
| SAM3 ONNX 三件套 | image_encoder ~1.8GB + language_encoder ~1.6GB + decoder ~116MB |

浏览器内跑 SAM3 只有走**量化 + WebGPU**才现实；真 SAM3 全量走 **Python sidecar**。

### 关键约定（先定死，避免返工）

1. **sidecar 形态**：Python 3.12 + torch + sam3，独立虚拟环境，**不进 exe**（torch+CUDA 几 GB）。
   开发期用 HTTP + 随机端口（方便 curl 调试），打包期切 stdio 长度前缀 JSON 帧。协议结构现在定死：
   请求 `{task: 'pvs'|'pcs', image_path, prompt, params}` → 响应 `{polygons[], rle_masks?, boxes[], scores[], instance_ids[]}`。
2. **传路径不传像素**：本地同机同用户，Python 直接读绝对路径。
   注意路径含中文（`D:\桌面\...`），**Python 侧必须显式 UTF-8**（Windows 默认 GBK 会炸）。
3. **返回 polygon 优先，掩码用 RLE**：轮廓提取放 Python（`cv2.findContours` + `approxPolyDP`），前端只负责画；不要传 PNG/base64。
4. **权重是 gated 的**：`facebook/sam3` 要申请访问 + `hf` 登录才能下载，首次启动要做检测与引导。
5. **没有 GPU 就别硬上**：探测 device 并明确告知，不要静默变慢。

### 分阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 侦察 | 独立 conda 环境跑通 sam3 的 PVS + PCS，记录耗时/显存/权重体积 | 同一张图能出两种结果，有数据支撑取舍 |
| P1 抽适配层 | 新增 `src/lib/segment/backend.ts`（接口）+ registry（注册表）+ 各 provider；`Prompt`/`SegResult` 统一，`segment()` 改返回**数组**；Canvas 与弹窗只面向注册表 | 点击/负点/框选/批量四条路径行为与现在一致 |
| P2 浏览器第二后端 | 加 SAM2.1 Tiny provider 作为默认，SAM1/MobileSAM 保留回退 | 点选质量可见提升 |
| P3 sidecar 骨架 | Python 服务 + Rust 进程管理 + tauri command；**先用 SAM2.1 甚至假结果**跑在 Python 侧，只为打通链路 | 进程可启停、退出不残留、无 sidecar 时自动回退浏览器后端 |
| P4 SAM3 PVS | 换 Sam3Tracker 的点/框分割，作为 `sam3-pvs` 后端 | 同一交互下质量优于 SAM2.1 |
| P5 SAM3 PCS | 文本/示例框交互 + 多实例结果列表 + 逐个接受/丢弃/合并；按约定加第三个 `workMode` + 独立 `annotations` + 独立自动保存键 | 输入概念词一次出多个实例并落成标注，刷新能恢复 |
| P6 导出收尾 | COCO polygon / LabelMe / 掩码 PNG；统计与批量操作兼容分割模式 | 导出文件能被常见框架直接读 |

P3 之所以先做"假后端"：**进程边界是这次改造最大的不确定性**（启动、超时、退出清理、打包后路径解析），先把链路跑通，P4/P5 就只是换模型调用。

### 可借鉴的现成轮子

- `samexporter`（PyPI 0.5.0）：SAM / MobileSAM / SAM2 / SAM3 → ONNX，HF 上有 SAM3 预导出模型。
- `yolo-onnx-web`（npm）：浏览器内 SAM 3.1 的 PCS + PVS，用的就是 `onnxruntime-web@1.30.0`（与本项目同版本）。

---

## 已踩过的坑（别再踩）

### 2.0 版本新坑（Python GPU 后端）
15. **浏览器跑 SAM 全量模型是死路**：WebGPU fp16 输出 NaN、wasm CPU 慢到 15 秒，折腾一下午也跑不通。别再尝试在浏览器里跑大模型，直接上 Python sidecar。
16. **`sam3.1_multiplex_fp16.safetensors` 是视频跟踪模型，不是图像分割模型**：结构和 `build_sam3_image_model` 完全不匹配（493 个权重对不上），跑出来是垃圾。图像分割用 `sam3.pt`。
17. **Windows 上没有官方 triton 包**：`pip install triton` 找不到，要用 `triton-windows`。
18. **`torch.load(weights_only=True)` 不支持某些 pickle 格式**：safetensors 文件被当成 pickle 读会报错。`.pt` 文件直接用 `build_sam3_image_model(checkpoint_path=...)` 加载即可。
19. **首次 CUDA 推理慢**：第一次 predict 要 800ms+（kernel 编译），第二次开始只要 10-50ms。正常现象，不是 bug。

### 1.0 版本旧坑（浏览器 ONNX）

1. **环境**：Rust 工具链在 E 盘（`CARGO_HOME=E:\.cargo`、`RUSTUP_HOME=E:\.rustup`），不占 C 盘。新开 PowerShell 窗口要先刷新 PATH：
   `$env:Path = [System.Environment]::GetEnvironmentVariable("Path","User") + ";" + [System.Environment]::GetEnvironmentVariable("Path","Machine")`
2. **打包前必须先关 exe**：`Stop-Process -Name "annotator-pro" -Force`，否则链接器报 `os error 5`。
3. **Tauri 调用不要用 `__TAURI_INTERNALS__` 环境检测**（实测打包后会误判成浏览器）。
   现在的做法：`tauriInvoke()` 里直接 `await import('@tauri-apps/api/core')`，失败 catch 返回 `null`，调用方据此回退浏览器实现。新增原生文件操作时照这个模式。
4. **Tauri 拖拽进画布**：早期实现（onFileDropEvent + 动态 import fs）会导致白屏，目前整段被注释禁用，别轻易恢复，要做先小步验证。
5. **工作模式数据隔离**：目标检测和图像分类是两套独立状态（`workMode`、`annotations`、`imageLabels`），新增分割模式时同样要彻底隔离，别复用错变量。
6. **两种模式的自动保存**：分类模式之前刷新后恢复不正常，改完务必实测"标注 → 刷新 → 是否原样回来"。
7. 文件夹导入是**递归读子目录**，数量多于顶层文件数是正常的。
8. **ort 的 wasm 资源路径不能写死 `/node_modules/...`**：dev 能过、打包后 404，模型直接加载不了。
   统一走 `src/lib/ortRuntime.ts`，用 Vite 的 `?url` 导入（dev 与打包都实测通过）。
9. **`session.executionProviders` 在 ort-web 里运行时是 `undefined`**（类型里也没有）。
   想知道 GPU 到底有没有生效，看**编码耗时**（GPU 0.2~1s vs CPU 6s+），或看有没有 `回退 wasm(CPU)` 的 warning。
10. **fp16 encoder 放 CPU 上很慢**：日志刷 `Could not find a CPU kernel ... Div` 就是 cast 回退的信号。fp16 是给 GPU 用的。
11. **SAM 参数是即时持久化的**（localStorage 的 `sam_settings`），没有"保存"按钮；所以设错一次会一直是错的。
    现在弹窗有回显 + 恢复默认 + 重跑，改完参数不用回画布重新点。
12. **`orig_im_size` 决定 mask 输出尺寸**：官方 SAM1 导出会把 mask 插值回原图，所以多边形不用逆变换；换导出格式后必须重新确认。
13. **`npm run build` 不跑类型检查**：`npx tsc --noEmit` 能看到既有错误（例如 `yolo.ts` 里 `readonly number[]` 那个，与本次改动无关）。
14. **AI 会话里跑 npm 需要重定向 cache**：npm 默认 cache 在 `D:\DevData\npm-cache`（沙箱不可写），会让命令退出码非 0。
    加一句即可：`$env:npm_config_cache="E:\TempCache\npm"`。

## 常用命令

```powershell
cd "D:\桌面\图像标注\annotator-pro"
npm run dev          # 网页调试 http://localhost:1420
npm run tauri dev    # 桌面调试（原生窗口）
npm run build        # 打包前必须先跑
npm run tauri build  # 出 exe → src-tauri\target\release\annotator-pro.exe
```

## 模型文件放哪

- 模型不入库（.gitignore 已忽略 `*.onnx/*.pt`），自己本地存。
- **SAM 3（当前用的）：** `E:\Doubao download\sam3.pt`（3.21 GB）
- YOLO 已验证可用：`E:\Doubao download\yolov8n.onnx`（12.2MB）。
- 旧的 SAM1 ONNX 文件已废弃：`sam_vit_b_01ec64.*.onnx`，不要再用。

---

## 下一步的第一件事

加 **PCS 文本提示分割**：在 SAM 弹窗里加个输入框，输入"猫"、"狗"，后端调用 `set_text_prompt`，自动找到图里所有对应物体并输出多边形。