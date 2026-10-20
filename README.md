<div align="center">

<img src="assets/logo.svg" alt="Annotator Pro" width="720">

</div>

# Annotator Pro

本地运行的图像标注工具，面向 **目标检测 / 图像分类 / 图像分割** 三类任务。

桌面端是 **Tauri 2 + Svelte 5**，AI 推理走本地 Python 服务（**SAM3 / YOLO**），全程离线、不依赖任何云服务。

- 标注数据以工程文件（`.annotator`）保存，支持自动保存与撤销/重做
- 图片 `name` 支持子目录（如 `jpg/9.jpg`），导出文件名自动只用 basename，不会凭空建目录
- 三种模式的标注数据彼此独立，互不污染

---

## 三种工作模式

| 模式 | 能力 | 导出 |
|---|---|---|
| **目标检测** | 矩形 / 多边形 / 旋转框 / 关键点（骨架模板：人体 17、人脸 68、手部 21、自定义）；SAM3 点·框·文本提示；YOLO onnx 预标注；魔术棒；批量操作 | VOC / YOLO / COCO / LabelMe / CreateML / PNG / JPG / U-Net Mask |
| **图像分类** | 整图打多标签、批量打标、按标签筛选 | 分类 CSV |
| **图像分割** | SAM3 像素级掩膜：文本提示（开放词汇）、一键全类扫描、画笔/橡皮/负点修正、区域合并与孤岛清理、整目录批量扫描 | COCO 实例 JSON / Cityscapes 语义 PNG / 实例掩膜 PNG / U-Net PNG |

## 功能亮点

### 目标检测
- 矩形、多边形、旋转框、关键点四类标注；关键点按**骨架模板**管理，导出时用骨架类别
- 关键点不冒充目标类别：不画类别角标、不进类别统计；VOC/YOLO 这类没有关键点概念的格式会**明确提示**已跳过
- 魔术棒（按图片缓存整图数据，大图连点不卡）
- 批量改类别 / 批量删除 / 批量打标签，均可整体 `Ctrl+Z`
- 图片质量筛查（过暗、重复图等）与标注质量校验

### 图像分类
- 一张图可打多个标签；标签表与检测类别共用
- 批量打标 / 批量删标，状态栏正确显示「未保存 → 已保存」

### 图像分割（SAM3 像素级）
- **开放词汇文本提示**：输入任意英文词（或中文，内置驾驶场景词表），ENTER 出候选
- **一键全类扫描**：勾选类别后逐词跑 SAM3，按分数分层——高置信自动接受、中间带留给你逐类「复核」；整轮只占一个 `Ctrl+Z`
- **修正工具**：画笔补漏、橡皮削边、**负点修正**（正点保留 / Shift 负点排除，累积提示点重新分割）、孤立小块清理、区域合并
- **整目录批量扫描**：对每张图跑同一套词表，带进度与取消，每张图各自一个撤销点
- **导出**：COCO 实例（列主序 RLE）、Cityscapes 语义（trainId，未映射/未标注写 255 void）、实例掩膜（索引图 + 逐实例 PNG + 清单）、U-Net
- 编码缓存：同一张图只 embed 一次，切回最近的几张图不再重编码

### 通用
- 工程保存 / 打开（含图片路径、类别、导出设置、分割掩膜）
- 改动后 500 ms 自动保存到本地缓存；`Ctrl+S` 立即保存
- 撤销 / 重做（跨图、批量操作整体还原；三种模式各自独立的历史）
- 拖拽导入图片或整个文件夹
- 深色 / 浅色主题

---

## 快速开始

### 环境要求

| 组件 | 版本 / 说明 |
|---|---|
| Windows | 10 / 11（WebView2 运行时） |
| Node.js | ≥ 18 |
| Rust + Tauri CLI | 首次 `tauri build` 会编译 Rust 代码 |
| Python | 3.10+，CUDA 环境（AI 功能需要） |

> **Windows 路径注意**：请把项目放在**纯英文路径**下（不要含中文），否则 WebView2 可能加载失败（`msedge_elf.dll` / `STATUS_BREAKPOINT`）。

### 安装与运行

```bash
npm install

npm run dev          # 浏览器预览（最快，http://localhost:1420）
npm run tauri dev    # 原生窗口 + 热更新
npm run build        # 只更新 dist/
npm run tauri build  # 打包成品
npm run check        # svelte-check 类型检查
```

### 启动 AI 后端（可选，AI 功能需要）

**方式一：一键脚本（推荐）**

编辑 `start_backend.bat` 顶部的 `PYTHON_EXE` / `SAM3_MODEL_PATH` / `POSE_MODEL_PATH` / `TORCH_HOME` 为你的本地路径，然后双击运行。

**方式二：命令行**

```powershell
$env:SAM3_MODEL_PATH  = "D:\models\sam3.pt"          # SAM3 主模型
$env:POSE_MODEL_PATH  = "D:\models\yolov8n-pose.pt"  # 可选：人体姿态

python src-tauri/sidecar/sam_server.py
# 看到 SAM_SERVER_READY http://127.0.0.1:1421 即成功（冷启动 10~30 秒）
```

后端依赖：`torch`（CUDA）、[`sam3`](https://github.com/facebookresearch/sam3)、`ultralytics`（姿态）、
`face_alignment`（68 点人脸）。模型不入库，请自行下载后通过上面的环境变量指过去。

---

## 快捷键

| 操作 | 快捷键 |
|---|---|
| 选择 / 矩形 / 多边形 / 旋转框 / 关键点 | `V` / `R` / `P` / `O` / `K` |
| 魔术棒 / SAM | `W` / `M` |
| 撤销 / 重做 | `Ctrl+Z` / `Ctrl+Y` |
| 删除选中 / 复制选中 | `Delete` / `Ctrl+D` |
| 缩放 / 适应窗口 | `Ctrl+=` `Ctrl+-` / `Ctrl+0` |
| 保存 | `Ctrl+S` |

分割模式工具：`V` 选择区域 · `T` 文本提示 · `B` 点提示 · `W` 画笔 · `E` 橡皮 · `R` 负点修正；
`Shift`+点击另一个区域 = 合并。

---

## 导出格式

| 格式 | 说明 |
|---|---|
| VOC XML | 矩形 / 旋转框，文件名用 basename |
| YOLO TXT | 检测与 OBB；`classes.txt` 单独输出 |
| COCO JSON | 检测与关键点；单图 / 合并两版 |
| LabelMe JSON | 支持矩形、多边形、点、线 |
| CreateML JSON | 矩形框 |
| PNG / JPG 可视化 | 带标注的可视化图（关键点不画类别角标） |
| U-Net Mask PNG | 单通道灰度，0=背景，k=类别序号 |
| Cityscapes 语义 PNG | 分割模式：trainId 0~18，未映射/未标注 = 255(void) |
| 实例掩膜 PNG | 分割模式：`indexmap` + `0001_class.png`… + `instances.json` |
| 分类 CSV | 一行 = 一张图的一个标签 |

---

## 项目结构

```
src/
  App.svelte                布局、导入、导出、工程、模式选择
  components/               画布、工具栏、侧栏、属性面板、分割面板、各种弹窗
  lib/
    state.svelte.ts         全局状态 + 历史 + 持久化
    canvas/engine.svelte.ts Canvas2D 渲染 + 坐标换算 + 命中测试
    segmentation/           分割模式：数据模型、RLE、SAM 客户端、overlay、store
    export/                 VOC/YOLO/COCO/… 与分割导出
    sam.ts / yolo.ts        AI 客户端
    project.svelte.ts       .annotator 工程文件
src-tauri/
  src/lib.rs                12 个 Tauri 命令（读写图片、保存文件、sidecar 等）
  sidecar/sam_server.py     FastAPI 推理服务（/embed /predict /pcs /pose /face /health）
  capabilities/ tauri.conf.json icons/
```

---

## 已知限制

- 拖拽导入的图片拿不到磁盘绝对路径（浏览器安全限制），工程里 `path` 为空，重开需重新导入；用「导入文件夹 / 添加图片」会记录路径
- 分割模式的重叠像素按「后接受者覆盖」处理；COCO 导出只写实例区域，`road/sky` 这类整片同理
- 掩膜会随工程文件保存，同时写本地缓存（2.5 MB 预算，超出会提示改用「保存工程」）
- 自定义骨架模板存在本机；换机器打开工程时找不到模板会退化为按点数推断
- AI 功能需要手动启动 Python 后端（见上）

---

## 更新日志

### v2.0.0 · 首个公开版本

- **新增图像分割模式**：SAM3 像素级掩膜标注，与检测 / 分类模式数据完全独立
- 分割：文本提示（开放词汇 + 街景词表）、点提示、一键全类扫描（分数分层 + 复核 + 单次撤销）
- 分割：画笔 / 橡皮 / 负点修正 / 孤岛清理 / 区域合并；整目录批量扫描；编码缓存
- 分割导出：COCO 实例、Cityscapes 语义、实例掩膜、U-Net，均支持批量
- 保存语义统一：三种模式共用保存按钮 / `Ctrl+S` / 500 ms 自动保存与状态栏提示
- 性能：魔术棒整图数据缓存、切图不再重复编码
- 修复：LabelMe 导入后画布不刷新、批量打标签不置「未保存」、类型检查 0 错误
