# -*- coding: utf-8 -*-
"""
SAM 3 FastAPI 推理服务
供 Tauri Sidecar 启动，前端通过 HTTP localhost 调用
- /embed   图片编码（SAM3）
- /predict 点选分割（SAM3）
- /pcs     文本提示分割（SAM3 grounding）
- /pose    人体 17 点（YOLOv8n-pose）
- /face    人脸 68 点（face_alignment 2DFAN4）
"""
import io
import os
import uuid
import time
import base64
import threading
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
POSE_MODEL_PATH = os.environ.get(
    "POSE_MODEL_PATH",
    r"E:\Doubao download\yolov8n-pose.pt"
)
HOST = "127.0.0.1"
PORT = int(os.environ.get("SAM_PORT", "1421"))

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

# 人体 / 人脸模型（懒加载，避免拖慢启动）
pose_model = None
pose_lock = threading.Lock()
face_model = None
face_lock = threading.Lock()


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


class PcsRequest(BaseModel):
    image_id: str
    text: str
    confidence_threshold: float = 0.3


class PcsResponse(BaseModel):
    instances: list  # [{polygon, score, box}]
    elapsed_ms: float


class PoseRequest(BaseModel):
    image_base64: str
    conf: float = 0.25


class PoseResponse(BaseModel):
    persons: list  # [{keypoints: [[x,y,conf],...], score}]


class FaceRequest(BaseModel):
    image_base64: str


class FaceResponse(BaseModel):
    faces: list  # [{keypoints: [[x,y],...]}]


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


# ====== 接口：文本提示分割（PCS） ======
@app.post("/pcs", response_model=PcsResponse)
def pcs(req: PcsRequest):
    if processor is None:
        raise HTTPException(503, "Model not loaded yet")

    state = state_cache.get(req.image_id)
    if state is None:
        raise HTTPException(404, "Image not found, call /embed first")

    t0 = time.time()
    with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.bfloat16):
        processor.set_confidence_threshold(req.confidence_threshold, state)
        st = processor.set_text_prompt(req.text, state)
    elapsed = (time.time() - t0) * 1000

    masks = st["masks"].cpu().numpy()  # (N,1,H,W) bool
    boxes = st["boxes"].float().cpu().numpy()  # (N,4) x1y1x2y2
    scores = st["scores"].float().cpu().numpy()  # (N,)

    instances = []
    for i in range(len(masks)):
        mask_uint8 = masks[i][0].astype(np.uint8) * 255
        contours, _ = cv2.findContours(mask_uint8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        polygon: list[list[float]] = []
        if contours:
            largest = max(contours, key=cv2.contourArea)
            epsilon = 0.002 * cv2.arcLength(largest, True)
            approx = cv2.approxPolyDP(largest, epsilon, True)
            polygon = approx.reshape(-1, 2).tolist()
        if len(polygon) >= 3:
            instances.append({
                "polygon": polygon,
                "score": float(scores[i]),
                "box": [float(v) for v in boxes[i].tolist()],
            })

    print(f"[SAM Server] pcs: '{req.text}' -> {len(instances)} instances, {elapsed:.0f}ms")
    return PcsResponse(instances=instances, elapsed_ms=elapsed)


# ====== 接口：人体 17 点（YOLOv8n-pose，懒加载） ======
def _get_pose_model():
    global pose_model
    if pose_model is None:
        with pose_lock:
            if pose_model is None:
                from ultralytics import YOLO
                print(f"[SAM Server] Loading pose model from {POSE_MODEL_PATH} ...")
                t0 = time.time()
                pose_model = YOLO(POSE_MODEL_PATH)
                print(f"[SAM Server] Pose model loaded in {time.time()-t0:.1f}s")
    return pose_model


@app.post("/pose", response_model=PoseResponse)
def pose(req: PoseRequest):
    yolo = _get_pose_model()

    img_bytes = base64.b64decode(req.image_base64)
    img = cv2.imdecode(np.frombuffer(img_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "Invalid image")

    t0 = time.time()
    results = yolo(img, conf=req.conf, verbose=False)
    elapsed = (time.time() - t0) * 1000

    persons = []
    for r in results:
        if r.keypoints is None:
            continue
        kps = r.keypoints.data.cpu().numpy()  # (N,17,3)
        confs = r.boxes.conf.cpu().numpy() if r.boxes is not None else np.ones(len(kps))
        for i in range(len(kps)):
            k = kps[i].tolist()
            persons.append({
                "keypoints": [[pt[0], pt[1], pt[2]] for pt in k],
                "score": float(confs[i]),
            })

    print(f"[SAM Server] pose: {len(persons)} persons, {elapsed:.0f}ms")
    return PoseResponse(persons=persons)


# ====== 接口：人脸 68 点（face_alignment 2DFAN4，懒加载） ======
def _get_face_model():
    global face_model
    if face_model is None:
        with face_lock:
            if face_model is None:
                import face_alignment
                print("[SAM Server] Loading face model (2DFAN4) ...")
                t0 = time.time()
                face_model = face_alignment.FaceAlignment(
                    face_alignment.LandmarksType.TWO_D,
                    device="cuda",
                    flip_input=False,
                )
                print(f"[SAM Server] Face model loaded in {time.time()-t0:.1f}s")
    return face_model


@app.post("/face", response_model=FaceResponse)
def face(req: FaceRequest):
    fa = _get_face_model()

    img_bytes = base64.b64decode(req.image_base64)
    pil_img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    rgb = np.array(pil_img)

    t0 = time.time()
    preds = fa.get_landmarks(rgb)
    elapsed = (time.time() - t0) * 1000

    faces = []
    if preds is not None:
        for p in preds:
            pts = p.tolist()
            if len(pts) < 3:
                continue
            faces.append({"keypoints": [[pt[0], pt[1]] for pt in pts]})

    print(f"[SAM Server] face: {len(faces)} faces, {elapsed:.0f}ms")
    return FaceResponse(faces=faces)


# ====== 健康检查 ======
@app.get("/health")
def health():
    return {
        "status": "ok",
        "model_loaded": model is not None,
        "pose_loaded": pose_model is not None,
        "face_loaded": face_model is not None,
        "cached_images": len(state_cache)
    }


if __name__ == "__main__":
    import uvicorn
    print(f"SAM_SERVER_READY http://{HOST}:{PORT}", flush=True)
    uvicorn.run(app, host=HOST, port=PORT)
