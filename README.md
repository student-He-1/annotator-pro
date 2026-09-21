# Annotator Pro

本地运行的桌面端图像标注工具，基于 **Tauri 2 + Svelte 5** 构建。

> 个人学习练手作品，不对外分发、不用于商业用途。

---

## 版本更新

### v2.0（2026-09-20）— SAM 3 GPU 重构

**核心升级：SAM 智能分割从浏览器 ONNX 推理 → Python GPU 推理**

| 维度 | v1.0（旧） | v2.0（新） |
|------|-----------|-----------|
| **推理方案** | 浏览器 onnxruntime-web（纯 CPU wasm） | Python FastAPI + PyTorch + CUDA GPU |
| **分割模型** | MobileSAM / SAM ViT-B | SAM 3（Meta 最新） |
| **图片编码** | ~15 秒 | ~1.3 秒（**11x 提升**） |
| **点预测** | ~1 秒+ | ~10 毫秒（**100x 提升**） |
| **分割质量** | fp16 NaN 垃圾值 | 完美（score 0.977） |
| **推理设备** | 纯 CPU | NVIDIA GPU（CUDA） |

**改动：**
- 新增 `python/sam_server.py` — FastAPI GPU 推理服务
- 重写 `src/lib/sam.ts` — 从浏览器 ONNX 改为 fetch 调用 Python 后端
- 更新 `SamModelModal.svelte` — 从"上传 ONNX 文件"改为"连接后端服务"

**保留不动：**
- Canvas 画布交互、坐标转换
- 标注管理、导入导出、YOLO、魔术棒

---

### v1.0（2026-09-18）— 初始版本

- Tauri 2 + Svelte 5 桌面标注工具
- 支持目标检测 / 图像分类双模式
- 内置矩形框、多边形、旋转框、关键点、魔术棒标注工具
- YOLO 预标注（ONNX 本地推理）
- SAM 智能分割（浏览器 ONNX，纯 CPU）
- 支持 VOC / YOLO / COCO / CreateML / LabelMe 导出

---

## 文档

详细的环境搭建、开发命令、架构说明，请见：
📄 [开发说明日志.md](./开发说明日志.md)

---

*This is a personal learning project. No commercial use.*
