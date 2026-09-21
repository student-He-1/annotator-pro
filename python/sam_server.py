# -*- coding: utf-8 -*-
"""
SAM 3 FastAPI 推理服务
供 Tauri Sidecar 启动，前端通过 HTTP localhost 调用
"""
import io
import os
import uuid
import time
from typing import Optional

import cv2
import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

from sam3.model_builder import build_sam3_image_model
from sam3.model.sam3_image_processor import Sam3Processor

# ====== 配置 ======
MODEL_PATH = os.environ.get(
    "SAM3_MODEL_PATH",
    r"E:\Doubao download\sam3.pt"
)
HOST = "127.0.0.1"
PORT = 1421  # 前端 dev server 是 1420，后端用 1421

torch.backends.cuda.matmul.allow_tf32 = True
torch.backends.cudnn.allow_tf32 = True

# ====== 全局状态 ======
app = FastAPI(title="SAM 3 Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

model = None
processor = None
# inference_state 缓存：image_id -> state
state_cache: dict[str, object] = {}


# ====== 请求/响应模型 ======
class EmbedRequest(BaseModel):
    image_base64: str  # base64 编码的图片


class EmbedResponse(BaseModel):
    image_id: str
    width: int
    height: int
    elapsed_ms: float


class PredictRequest(BaseModel):
    image_id: str
    x: float
    y: float
    label: int = 1  # 1=正点(前景), 0=负点(背景)
    multimask: bool = True


class PredictResponse(BaseModel):
    polygon: list[list[float]]  # [[x, y], [x, y], ...]
    score: float
    elapsed_ms: float


# ====== 启动时加载模型 ======
@app.on_event("startup")
def load_model():
    global model, processor
    print(f"[SAM Server] Loading model from {MODEL_PATH} ...")
    t0 = time.time()

    # 标准方式加载（.pt 文件直接用 build_sam3_image_model）
    model = build_sam3_image_model(
        checkpoint_path=MODEL_PATH,
        enable_inst_interactivity=True
    )
    model.to("cuda")
    processor = Sam3Processor(model)

    elapsed = time.time() - t0
    print(f"[SAM Server] Model loaded in {elapsed:.1f}s")


# ====== 接口：图片编码 ======
@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest):
    import base64

    if processor is None:
        raise HTTPException(503, "Model not loaded yet")

    # base64 -> PIL
    img_bytes = base64.b64decode(req.image_base64)
    pil_img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    w, h = pil_img.size

    t0 = time.time()
    with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.bfloat16):
        state = processor.set_image(pil_img)
    elapsed = (time.time() - t0) * 1000

    image_id = str(uuid.uuid4())
    state_cache[image_id] = state

    # 简单的缓存清理：最多留 5 张
    if len(state_cache) > 5:
        oldest = next(iter(state_cache))
        del state_cache[oldest]

    print(f"[SAM Server] embed: {w}x{h}, {elapsed:.0f}ms, id={image_id[:8]}")
    return EmbedResponse(image_id=image_id, width=w, height=h, elapsed_ms=elapsed)


# ====== 接口：点预测 ======
@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest):
    if model is None:
        raise HTTPException(503, "Model not loaded yet")

    state = state_cache.get(req.image_id)
    if state is None:
        raise HTTPException(404, "Image not found, call /embed first")

    t0 = time.time()
    with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.bfloat16):
        masks, scores, _ = model.predict_inst(
            inference_state=state,
            point_coords=np.array([[req.x, req.y]]),
            point_labels=np.array([req.label]),
            multimask_output=req.multimask
        )
    elapsed = (time.time() - t0) * 1000

    if len(scores) == 0:
        return PredictResponse(polygon=[], score=0.0, elapsed_ms=elapsed)

    best_idx = int(np.argmax(scores))
    mask_np = masks[best_idx].cpu().numpy() if torch.is_tensor(masks) else masks[best_idx]
    score_val = float(scores[best_idx].cpu() if torch.is_tensor(scores) else scores[best_idx])

    mask_uint8 = (mask_np > 0.5).astype(np.uint8) * 255
    contours, _ = cv2.findContours(mask_uint8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    polygon: list[list[float]] = []
    if contours:
        largest = max(contours, key=cv2.contourArea)
        epsilon = 0.002 * cv2.arcLength(largest, True)
        approx = cv2.approxPolyDP(largest, epsilon, True)
        polygon = approx.reshape(-1, 2).tolist()

    print(f"[SAM Server] predict: ({req.x:.0f},{req.y:.0f}), score={score_val:.3f}, {elapsed:.0f}ms")
    return PredictResponse(polygon=polygon, score=score_val, elapsed_ms=elapsed)


# ====== 健康检查 ======
@app.get("/health")
def health():
    return {
        "status": "ok",
        "model_loaded": model is not None,
        "cached_images": len(state_cache)
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)
