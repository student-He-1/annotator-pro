# NEXT.md — 下一步开发交接

> 这个文件是给「下一次对话的开发者（AI / 我自己）」看的快速上手笔记。
> 项目正式说明见 [README.md](./README.md) 与 [开发说明日志.md](./开发说明日志.md)。

## 本次要做什么

**新增 / 升级「SAM 辅助图像分割」能力，目标是接入 SAM3（或更强的分割模型）做高精度图像分割。**
当前版本把 SAM 作为目标检测模式下的一个工具（输出多边形），后续考虑发展为独立的「图像分割」工作模式（语义/实例分割）。

## 当前 SAM 实现现状（不要从零开始写）

代码已经搭好骨架，在 `src/lib/sam.ts`：

- 已实现：ONNX Runtime Web 加载、标准双文件格式（`image_encoder.onnx` + `prompt_encoder_mask_decoder.onnx`）、
  point prompt（正/负点）、box prompt、mask → 多边形轮廓简化（复用 `magicwand.ts` 的 `extractContour/simplifyPolygon`）。
- 配置项在 `SamConfig`：encoder 输入 1024、mask 阈值、多边形简化精度、多 mask 候选。
- 弹窗 UI：`src/components/SamModelModal.svelte`（选择 encoder/decoder 两个 onnx、调参数）。
- **未完成 / 未验证：模型文件未下载、未真正跑通过一次推理。** 所谓"已实现"只是代码路径通了，需要拿真实 onnx 实测。

### 接入 SAM3 时要注意

- SAM3 的输入/输出张量格式、prompt 接口可能和 SAM1 不同，**先确认它的 ONNX 导出方式与张量名/形状**，别硬套现有 SAM1 的预处理。
- 模型体积大，浏览器 WASM 推理要关注：加载进度提示、内存、是否需要 WebGPU/SharedArrayBuffer（onnxruntime-web 的线程 wasm 需要正确响应头，Tauri 里要额外处理）。
- 大模型可能导致卡顿，考虑"按需加载"和进度条。

## 已踩过的坑（别再踩）

1. **环境**：Rust 工具链在 E 盘（`CARGO_HOME=E:\.cargo`、`RUSTUP_HOME=E:\.rustup`），不占 C 盘。新开 PowerShell 窗口要先刷新 PATH：
   `$env:Path = [System.Environment]::GetEnvironmentVariable("Path","User") + ";" + [System.Environment]::GetEnvironmentVariable("Path","Machine")`
2. **打包前必须先关 exe**：`Stop-Process -Name "annotator-pro" -Force`，否则链接器报 `os error 5`。
3. **Tauri 调用不要用 `__TAURI_INTERNALS__` 环境检测**（实测打包后会误判成浏览器）。
   现在的做法：`tauriInvoke()` 里直接 `await import('@tauri-apps/api/core')`，失败 catch 返回 `null`，调用方据此回退浏览器实现。新增原生文件操作时照这个模式。
4. **Tauri 拖拽进画布**：早期实现（onFileDropEvent + 动态 import fs）会导致白屏，目前整段被注释禁用，别轻易恢复，要做先小步验证。
5. **工作模式数据隔离**：目标检测和图像分类是两套独立状态（`workMode`、`annotations`、`imageLabels`），新增分割模式时同样要彻底隔离，别复用错变量。
6. **两种模式的自动保存**：分类模式之前刷新后恢复不正常，改完务必实测"标注 → 刷新 → 是否原样回来"。
7. 文件夹导入是**递归读子目录**，数量多于顶层文件数是正常的。

## 常用命令

```powershell
cd "D:\桌面\图像标注\annotator-pro"
npm run dev          # 网页调试 http://localhost:1420
npm run tauri dev    # 桌面调试（原生窗口）
npm run build        # 打包前必须先跑
npm run tauri build  # 出 exe → src-tauri\target\release\annotator-pro.exe
```

## 模型文件放哪

- 模型不入库（.gitignore 已忽略 `*.onnx/*.pt`），自己本地存，软件里弹窗手动加载。
- YOLO 已验证可用：`E:\Doubao download\yolov8n.onnx`（约 12MB）。
- SAM3 / SAM / MobileSAM 的 onnx 需要自己导出/下载，放本地任意路径，运行时加载。

## 开发建议顺序

1. 先确认 SAM3 的 ONNX 导出方式与张量接口，必要时升级 `sam.ts` 的加载/推理代码。
2. 拿一个真实模型小步实测：能不能加载 → 能不能点一下出 mask → 能不能转成多边形落在画布上。
3. 再决定：是做成独立「图像分割」工作模式，还是继续当检测模式下的工具。
4. 每完成一步 `npm run tauri build` 实测 exe，别只在网页版验证。
