# Annotator Pro

本地运行的桌面端图像标注工具，基于 **Tauri 2 + Svelte 5 + Python FastAPI GPU 推理**。

> 个人学习练手作品，不对外分发、不用于商业用途。**v2.3 最终版，不再迭代。**

---

## 使用方法

### 1. 启动 Python 后端（必做）

```powershell
$env:TORCH_HOME="E:\TorchHub"
$env:PYTHONIOENCODING="utf-8"
& "D:\79458\Documents\anaconda3\envs\deeplearning\python.exe" "D:\桌面\图像标注\annotator-pro\src-tauri\target\release\sidecar\sam_server.py"
```

等控制台输出 `SAM_SERVER_READY http://127.0.0.1:1421`（约 10-30 秒，冷启动慢）。**这个窗口不要关。**

### 2. 启动前端

双击 `src-tauri\target\release\annotator-pro.exe`

或浏览器开发模式：
```powershell
$env:npm_config_cache="E:\TempCache\npm"
cd "D:\桌面\图像标注\annotator-pro"
npm install   # 首次，node_modules 已删
npm run dev
```
浏览器开 http://localhost:1420

### 前提

- Python 环境 `D:\79458\Documents\anaconda3\envs\deeplearning\python.exe`
- 模型文件 `E:\Doubao download\sam3.pt`、`yolov8n-pose.pt`
- face_alignment 权重 `E:\TorchHub\`

> 注：Tauri sidecar 自动拉起因模型冷启动超过 30 秒超时，已放弃。需手动起后端。

---

## 功能

- 矩形框 / 多边形 / 旋转框 / 关键点 / 魔术棒 / SAM 智能分割
- **PCS 文本提示分割**：输入文本一键分割全部实例
- **人体17点**（YOLOv8n-pose）、**人脸68点**（face_alignment）
- **批量预标注**：一键对全部/未标注图片跑 AI 检测
- **自定义关键点模板**、**U-Net Mask 导出**
- 导出 VOC / YOLO / COCO（带关键点）/ CreateML / LabelMe
- 标注统计、数据集划分、质量筛查

---

## 版本历史

| 版本 | 内容 |
|---|---|
| v2.3 | 自定义模板、U-Net 导出、Tauri sidecar（因超时放弃自动拉起） |
| v2.2 | 批量预标注、COCO 关键点导出 |
| v2.1 | PCS 文本分割、人体/人脸关键点 |
| v2.0 | SAM3 GPU 重构 |
| v1.0 | 初始版本 |

详细说明见 📄 [开发说明日志.md](./开发说明日志.md)
