/** SAM 一键分割 — 基于 Python FastAPI 后端（PyTorch + CUDA GPU 推理）
 *  后端服务：http://127.0.0.1:1421
 *  接口：
 *    POST /embed    — 图片编码，返回 image_id
 *    POST /predict  — 点预测，返回 polygon + score
 *  前端只负责调用，推理全部在 Python GPU 上跑
 */

export interface SamPoint {
  x: number;  // 原图坐标
  y: number;
  label: 1 | 0;  // 1=正点(前景), 0=负点(背景)
}

export interface SamBox {
  x: number; y: number; w: number; h: number;  // 原图坐标
}

export interface SamResult {
  mask: Uint8Array;       // 二值 mask，长度=width*height
  width: number;
  height: number;
  iou: number;            // 模型预测的 mask 质量分
  polygon: { x: number; y: number }[];  // mask 轮廓多边形（已简化）
}

export interface SamConfig {
  encoderInputSize: number;  // 保留兼容（后端处理）
  maskThreshold: number;      // 保留兼容（后端处理）
  simplifyTolerance: number;  // 保留兼容（后端处理）
  multiMask: boolean;         // 是否输出3个候选mask（取最优）
}

export const DEFAULT_SAM_CONFIG: SamConfig = {
  encoderInputSize: 1024,
  maskThreshold: 0.0,
  simplifyTolerance: 1.0,
  multiMask: true,
};

// ====== Python 后端配置 ======
const SAM_SERVER_URL = 'http://127.0.0.1:1421';

// ====== 状态 ======
let serverReady = false;
let cachedImageId = '';
let cachedImageKey = '';

// ====== 工具函数 ======

/** HTMLImageElement -> base64 */
function imageToBase64(img: HTMLImageElement): string {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.95).split(',')[1];
}

/** 生成图片缓存 key */
function imageKey(img: HTMLImageElement): string {
  return `${img.src}_${img.naturalWidth}x${img.naturalHeight}`;
}

// ====== 对外接口 ======

/**
 * 加载模型（实际上是检查 Python 后端是否在线）
 * 保留兼容接口，后端启动时自动加载模型
 */
export async function loadModel(_encoderFile: File, _decoderFile: File): Promise<void> {
  try {
    const resp = await fetch(`${SAM_SERVER_URL}/health`);
    const data = await resp.json();
    serverReady = data.model_loaded === true;
    if (!serverReady) {
      throw new Error('SAM 后端服务未就绪');
    }
  } catch (e) {
    serverReady = false;
    throw new Error('无法连接 SAM 后端服务，请确认 Python 服务已启动');
  }
}

export function isModelLoaded(): boolean {
  return serverReady;
}

export function getModelName(): string {
  return 'SAM 3 (GPU)';
}

/**
 * 一键分割
 * @param image 图片元素
 * @param points 点提示列表（正点/负点）
 * @param box 框提示（暂不支持，后端还没实现）
 * @param config 配置
 */
export async function segment(
  image: HTMLImageElement,
  points: SamPoint[] = [],
  _box: SamBox | null = null,
  config: SamConfig = DEFAULT_SAM_CONFIG
): Promise<SamResult> {
  if (!serverReady) throw new Error('SAM 后端服务未连接');
  if (points.length === 0) throw new Error('需要至少一个点提示');

  // 1. 图片编码（缓存：同一图片只 encode 一次）
  const key = imageKey(image);
  if (cachedImageKey !== key) {
    const b64 = imageToBase64(image);
    const resp = await fetch(`${SAM_SERVER_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: b64 }),
    });
    if (!resp.ok) throw new Error(`图片编码失败: ${resp.status}`);
    const data = await resp.json();
    cachedImageId = data.image_id;
    cachedImageKey = key;
  }

  // 2. 点预测（取第一个正点，后端目前只支持单点）
  const firstPoint = points.find(p => p.label === 1) || points[0];
  const resp = await fetch(`${SAM_SERVER_URL}/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_id: cachedImageId,
      x: firstPoint.x,
      y: firstPoint.y,
      label: firstPoint.label,
      multimask: config.multiMask,
    }),
  });
  if (!resp.ok) throw new Error(`分割失败: ${resp.status}`);
  const pred = await resp.json();

  // 3. 构造返回值
  const w = image.naturalWidth;
  const h = image.naturalHeight;

  // mask 暂时用空 Uint8Array（后端只返回 polygon，不返回完整 mask）
  // Canvas 渲染用的是 polygon，mask 主要用于导出
  const mask = new Uint8Array(w * h);

  const polygon: { x: number; y: number }[] = (pred.polygon || []).map(
    (pt: number[]) => ({ x: pt[0], y: pt[1] })
  );

  return {
    mask,
    width: w,
    height: h,
    iou: pred.score || 0,
    polygon,
  };
}

/**
 * 清除缓存（切换图片时调用）
 */
export function clearCache(): void {
  cachedImageId = '';
  cachedImageKey = '';
}
