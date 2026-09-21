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

export interface PcsInstance {
  polygon: { x: number; y: number }[];
  score: number;
  box: { x1: number; y1: number; x2: number; y2: number };
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
let SAM_SERVER_URL = 'http://127.0.0.1:1421';

export async function ensureSidecar(): Promise<string> {
  const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__; if (!isTauri) return SAM_SERVER_URL;
  const { invoke } = await import('@tauri-apps/api/core');
  const port = await invoke<number>('sam_sidecar_start');
  SAM_SERVER_URL = 'http://127.0.0.1:' + port;
  return SAM_SERVER_URL;
}

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
 * 一键分割（PVS 点/框提示）
 * @param image 图片元素
 * @param points 点提示列表（正点/负点）
 * @param box 框提示（原图坐标 x,y,w,h）；与 points 至少传一个
 * @param config 配置
 */
export async function segment(
  image: HTMLImageElement,
  points: SamPoint[] = [],
  box: SamBox | null = null,
  config: SamConfig = DEFAULT_SAM_CONFIG
): Promise<SamResult> {
  if (!serverReady) throw new Error('SAM 后端服务未连接');
  if (points.length === 0 && !box) throw new Error('需要至少一个点或框提示');

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

  // 2. 构建预测请求
  const body: Record<string, unknown> = {
    image_id: cachedImageId,
    multimask: config.multiMask,
  };
  if (points.length > 0) {
    const firstPoint = points.find(p => p.label === 1) || points[0];
    body.x = firstPoint.x;
    body.y = firstPoint.y;
    body.label = firstPoint.label;
  }
  if (box) {
    body.box = [box.x, box.y, box.x + box.w, box.y + box.h];
  }
  const resp = await fetch(`${SAM_SERVER_URL}/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
 * 文本提示分割（PCS）：输入文本，返回图中所有匹配实例
 */
export async function segmentByText(
  image: HTMLImageElement,
  text: string,
  confidenceThreshold: number = 0.5
): Promise<PcsInstance[]> {
  if (!serverReady) throw new Error('SAM 后端服务未连接');
  if (!text.trim()) throw new Error('请输入要检测的文本');

  // 1. 图片编码（复用缓存）
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

  // 2. 文本分割
  const resp = await fetch(`${SAM_SERVER_URL}/pcs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_id: cachedImageId,
      text: text.trim(),
      confidence_threshold: confidenceThreshold,
    }),
  });
  if (!resp.ok) throw new Error(`文本分割失败: ${resp.status}`);
  const data = await resp.json();

  return (data.instances || []).map((inst: any) => ({
    polygon: (inst.polygon || []).map((pt: number[]) => ({ x: pt[0], y: pt[1] })),
    score: inst.score || 0,
    box: {
      x1: inst.box?.[0] ?? 0,
      y1: inst.box?.[1] ?? 0,
      x2: inst.box?.[2] ?? 0,
      y2: inst.box?.[3] ?? 0,
    },
  }));
}

/**
 * 姿态关键点预标注（YOLO pose）：直接传图片，返回所有人的 17 个关键点
 */
export interface PosePerson {
  keypoints: { x: number; y: number; conf: number }[];
  score: number;
}

export async function poseDetect(
  image: HTMLImageElement,
  conf: number = 0.25
): Promise<PosePerson[]> {
  const b64 = imageToBase64(image);
  const resp = await fetch(`${SAM_SERVER_URL}/pose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_base64: b64, conf }),
  });
  if (!resp.ok) throw new Error(`姿态检测失败: ${resp.status}`);
  const data = await resp.json();
  return (data.persons || []).map((p: any) => ({
    keypoints: (p.keypoints || []).map((k: number[]) => ({ x: k[0], y: k[1], conf: k[2] ?? 0 })),
    score: p.score || 0,
  }));
}

/**
 * 人脸 68 点预标注（face_alignment）
 */
export async function faceDetect(
  image: HTMLImageElement
): Promise<{ keypoints: { x: number; y: number }[] }[]> {
  const b64 = imageToBase64(image);
  const resp = await fetch(`${SAM_SERVER_URL}/face`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_base64: b64 }),
  });
  if (!resp.ok) throw new Error(`人脸检测失败: ${resp.status}`);
  const data = await resp.json();
  return (data.faces || []).map((f: any) => ({
    keypoints: (f.keypoints || []).map((k: number[]) => ({ x: k[0], y: k[1] })),
  }));
}

/**
 * 清除缓存（切换图片时调用）
 */
export function clearCache(): void {
  cachedImageId = '';
  cachedImageKey = '';
}


// ====== 批量预标注 ======

export interface BatchPcsResult {
  name: string;
  instances: PcsInstance[];
  count: number;
  elapsed_ms: number;
}

async function urlToBase64(url: string): Promise<string> {
  const resp = await fetch(url);
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function batchPcs(
  dataUrls: string[],
  text: string,
  confidenceThreshold: number = 0.5
): Promise<BatchPcsResult[]> {
  const results: BatchPcsResult[] = [];
  for (let i = 0; i < dataUrls.length; i++) {
    const t0 = Date.now();
    const b64 = await urlToBase64(dataUrls[i]);
    const resp = await fetch(SAM_SERVER_URL + '/pcs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: b64, text: text.trim(), confidence_threshold: confidenceThreshold }),
    });
    if (!resp.ok) throw new Error('批量PCS失败: ' + resp.status);
    const data = await resp.json();
    const insts = (data.instances || []).map((inst: any) => ({
      polygon: (inst.polygon || []).map((pt: number[]) => ({ x: pt[0], y: pt[1] })),
      score: inst.score || 0,
      box: { x1: inst.box?.[0] ?? 0, y1: inst.box?.[1] ?? 0, x2: inst.box?.[2] ?? 0, y2: inst.box?.[3] ?? 0 },
    }));
    results.push({ name: 'img_' + i, count: insts.length, elapsed_ms: Date.now() - t0, instances: insts });
  }
  return results;
}
export interface BatchKpResult {
  name: string;
  objects: { keypoints: { x: number; y: number; conf?: number }[]; score: number }[];
  count: number;
  elapsed_ms: number;
}

export async function batchKp(
  dataUrls: string[],
  model: 'pose' | 'face',
  conf: number = 0.25
): Promise<BatchKpResult[]> {
  const results: BatchKpResult[] = [];
  const endpoint = model === 'pose' ? 'pose' : 'face';
  for (let i = 0; i < dataUrls.length; i++) {
    const t0 = Date.now();
    const b64 = await urlToBase64(dataUrls[i]);
    const resp = await fetch(SAM_SERVER_URL + '/' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: b64, conf }),
    });
    if (!resp.ok) throw new Error('批量' + model + '失败: ' + resp.status);
    const data = await resp.json();
    const arr = data.persons || data.faces || [];
    const objs = arr.map((o: any) => ({ keypoints: (o.keypoints || []).map((k: number[]) => ({ x: k[0], y: k[1] })), score: o.score || 0 }));
    results.push({ name: 'img_' + i, count: objs.length, elapsed_ms: Date.now() - t0, objects: objs });
  }
  return results;
}
