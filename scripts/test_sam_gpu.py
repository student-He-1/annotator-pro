"""P0 测试：SAM ViT-B GPU 推理速度"""
import time
import sys
sys.stdout.reconfigure(encoding='utf-8')

import torch
import cv2
import numpy as np
from segment_anything import sam_model_registry, SamPredictor

CHECKPOINT = r"E:\Doubao download\sam_vit_b_01ec64.pth"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

print(f"Device: {DEVICE}")
if DEVICE == "cuda":
    print(f"GPU: {torch.cuda.get_device_name(0)}")
    print(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")

# 加载模型
print("Loading model...")
t0 = time.time()
sam = sam_model_registry["vit_b"](checkpoint=CHECKPOINT)
sam.to(device=DEVICE)
predictor = SamPredictor(sam)
print(f"Model loaded in {time.time()-t0:.1f}s")

# 用一张测试图（找一张）
import os
test_images = []
for root in [r"D:\桌面\图像标注", r"E:\Doubao download"]:
    if os.path.exists(root):
        for f in os.listdir(root):
            if f.lower().endswith(('.jpg', '.jpeg', '.png')):
                test_images.append(os.path.join(root, f))
                break
    if test_images:
        break

if not test_images:
    print("No test image found")
    sys.exit(1)

img_path = test_images[0]
print(f"Test image: {img_path}")
image = cv2.imread(img_path)
image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
print(f"Image size: {image.shape}")

# 测 encoder
print("Running encoder...")
torch.cuda.synchronize() if DEVICE == "cuda" else None
t0 = time.time()
predictor.set_image(image)
torch.cuda.synchronize() if DEVICE == "cuda" else None
enc_ms = (time.time() - t0) * 1000
print(f"Encoder: {enc_ms:.0f} ms")

# 测 decoder（中心点）
h, w = image.shape[:2]
center = np.array([[w // 2, h // 2]])
print("Running decoder...")
torch.cuda.synchronize() if DEVICE == "cuda" else None
t0 = time.time()
masks, scores, logits = predictor.predict(
    point_coords=center,
    point_labels=np.array([1]),
    multimask_output=False,
)
torch.cuda.synchronize() if DEVICE == "cuda" else None
dec_ms = (time.time() - t0) * 1000
print(f"Decoder: {dec_ms:.0f} ms")
print(f"Mask shape: {masks.shape}, score: {scores[0]:.3f}")

print(f"\n=== Summary ===")
print(f"Encoder: {enc_ms:.0f} ms ({enc_ms/1000:.2f}s)")
print(f"Decoder: {dec_ms:.0f} ms")
print(f"100 images batch: ~{enc_ms*100/1000:.0f}s encoder + decoders")
