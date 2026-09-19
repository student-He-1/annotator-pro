# Annotator Pro

一个本地运行的桌面端图像标注工具，基于 **Tauri 2 + Svelte 5** 构建。支持「目标检测 / 图像分类」两种工作模式，内置矩形框、多边形、旋转框、关键点、魔术棒等标注工具，并集成 **YOLO 预标注**与 **SAM 智能分割**（ONNX 本地推理，图片不上传）。

> 本项目为**个人学习练手作品**，仅用于记录开发与学习过程，不对外分发、不用于任何商业用途。
>
> 项目中涉及的 AI 模型（如 YOLO、SAM / MobileSAM 等）及相关开源组件，均仅在本地作学习演示使用，版权与许可归原开源作者所有；如需正式使用，请遵守各项目原始开源协议。

## 功能

- **双工作模式**：目标检测 / 图像分类，数据互相隔离
- **标注工具**：矩形框、多边形、旋转框、关键点、魔术棒、SAM 分割
- **AI 辅助**：YOLO 预标注、SAM 智能分割（浏览器本地 ONNX 推理）
- **导出格式**：VOC / YOLO / COCO / CreateML / LabelMe / 可视化 PNG·JPG / 分类 CSV
- **效率工具**：批量操作、标注统计、数据集划分、图片质量筛查、工程保存与自动保存
- **桌面原生**：原生文件对话框、文件夹递归读取、本地保存并提示路径

## 技术栈

Tauri 2 · Svelte 5（Runes）· TypeScript · Vite · Rust · onnxruntime-web

## 文档

详细的环境搭建、开发命令、打包发布、AI 模型获取与使用说明，请见：

📄 [开发说明日志.md](./开发说明日志.md)

---

*This is a personal learning project. No commercial use. AI models and open-source components are used for study purposes only; their copyright remains with their respective owners.*
