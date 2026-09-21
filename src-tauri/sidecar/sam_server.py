"""SAM Sidecar HTTP Server
开发期用 HTTP，打包期切 stdio。
传图片路径不传像素，返回 polygon JSON。
"""
import json
import sys
import time
import os
from typing import Optional, List, Dict, Any
from http.server import HTTPServer, BaseHTTPRequestHandler

import torch
import cv2
import numpy as np
from segment_anything import sam_model_registry, SamPredictor

# 配置
CHECKPOINT = os.environ.get("SAM_CHECKPOINT", r"E:\Doubao download\sam_vit_b_01ec64.pth")
MODEL_TYPE = os.environ.get("SAM_MODEL_TYPE", "vit_b")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
PORT = int(os.environ.get("SAM_PORT", "0"))  # 0 = 随机端口

# 全局模型（启动时加载一次）
predictor = None  # type: Optional[SamPredictor]
current_image_key = None  # type: Optional[str]


def load_model():
    global predictor
    print(f"[SAM] Loading model {MODEL_TYPE} on {DEVICE}...", flush=True)
    sam = sam_model_registry[MODEL_TYPE](checkpoint=CHECKPOINT)
    sam.to(device=DEVICE)
    predictor = SamPredictor(sam)
    print(f"[SAM] Model loaded on {DEVICE}", flush=True)


def encode_image(image_path: str = None, image_b64: str = None):
    """加载图片并跑 encoder，缓存 embedding"""
    global predictor, current_image_key
    cache_key = image_path or image_b64
    if current_image_key == cache_key and predictor is not None:
        return

    if image_b64:
        # base64 输入（去掉 data:image/xxx;base64, 前缀）
        import base64
        if "," in image_b64:
            image_b64 = image_b64.split(",")[1]
        # 去掉空白字符
        image_b64 = image_b64.replace("\n", "").replace("\r", "").replace(" ", "")
        print(f"[SAM] Decoding base64, length={len(image_b64)}", flush=True)
        img_bytes = base64.b64decode(image_b64)
        print(f"[SAM] Decoded to {len(img_bytes)} bytes", flush=True)
        img_arr = np.frombuffer(img_bytes, dtype=np.uint8)
        image = cv2.imdecode(img_arr, cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError(f"cv2.imdecode failed, got {len(img_bytes)} bytes")
        print(f"[SAM] Decoded base64 image: {image.shape}", flush=True)
    else:
        # 文件路径输入
        img_data = np.fromfile(image_path, dtype=np.uint8)
        image = cv2.imdecode(img_data, cv2.IMREAD_COLOR)

    if image is None:
        raise ValueError("Cannot decode image")
    image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

    if DEVICE == "cuda":
        torch.cuda.synchronize()
    t0 = time.time()
    predictor.set_image(image)
    if DEVICE == "cuda":
        torch.cuda.synchronize()
    enc_ms = (time.time() - t0) * 1000
    print(f"[SAM] Encoded in {enc_ms:.0f}ms", flush=True)
    current_image_key = cache_key


def run_segment(
    points,  # type: List[Dict[str, Any]]
    box,  # type: Optional[Dict[str, Any]]
):
    """跑 decoder，返回 polygon + mask"""
    point_coords = []
    point_labels = []
    for p in points:
        point_coords.append([p["x"], p["y"]])
        point_labels.append(p["label"])

    box_coords = None
    if box:
        box_coords = np.array([
            [box["x"], box["y"]],
            [box["x"] + box["w"], box["y"] + box["h"]]
        ])

    if not point_coords and box_coords is None:
        raise ValueError("No prompt provided")

    if DEVICE == "cuda":
        torch.cuda.synchronize()
    t0 = time.time()

    masks, scores, logits = predictor.predict(
        point_coords=np.array(point_coords) if point_coords else None,
        point_labels=np.array(point_labels) if point_labels else None,
        box=box_coords,
        multimask_output=False,
    )

    if DEVICE == "cuda":
        torch.cuda.synchronize()
    dec_ms = (time.time() - t0) * 1000
    print(f"[SAM] Decoded in {dec_ms:.0f}ms, score={scores[0]:.3f}", flush=True)

    mask = masks[0]
    score = float(scores[0])

    # 提取轮廓
    contours, _ = cv2.findContours(
        (mask.astype(np.uint8) * 255),
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_SIMPLE,
    )
    if not contours:
        return {"polygon": [], "score": score, "dec_ms": dec_ms}

    # 取最大轮廓
    largest = max(contours, key=cv2.contourArea)
    # 简化多边形
    epsilon = 0.002 * cv2.arcLength(largest, True)
    approx = cv2.approxPolyDP(largest, epsilon, True)

    polygon = [{"x": float(p[0][0]), "y": float(p[0][1])} for p in approx]

    return {
        "polygon": polygon,
        "score": score,
        "dec_ms": dec_ms,
        "mask_size": [int(mask.shape[0]), int(mask.shape[1])],
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # 静音默认日志

    def send_json(self, data: dict, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.send_json({
                "status": "ok",
                "device": DEVICE,
                "model_loaded": predictor is not None,
            })
        else:
            self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path == "/segment":
            try:
                length = int(self.headers.get("Content-Length", 0))
                print(f"[SAM] Received POST, Content-Length={length}", flush=True)
                raw = self.rfile.read(length)
                print(f"[SAM] Read {len(raw)} bytes", flush=True)
                req = json.loads(raw.decode("utf-8"))

                image_path = req.get("image_path")
                image_b64 = req.get("image_b64")
                points = req.get("points", [])
                box = req.get("box")

                encode_image(image_path, image_b64)
                result = run_segment(points, box)

                self.send_json(result)
            except Exception as e:
                import traceback
                tb = traceback.format_exc()
                print(tb, file=sys.stderr, flush=True)
                self.send_json({"error": f"{e}\n{tb}"}, 500)
        else:
            self.send_json({"error": "not found"}, 404)


def main():
    load_model()

    server = HTTPServer(("127.0.0.1", PORT), Handler)
    actual_port = server.server_address[1]
    print(f"[SAM] Sidecar listening on http://127.0.0.1:{actual_port}", flush=True)
    print(f"[SAM] READY", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[SAM] Shutting down...", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main()
