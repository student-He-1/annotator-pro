/** SAM 一键分割 — 基于 Python FastAPI 后端（PyTorch + CUDA GPU 推理）
 *  后端服务：http://127.0.0.1:1421
 *  接口：
 *    POST /embed    — 图片编码，返回 image_id
 *    POST /predict  — 点预测，返回 polygon + score
 *  前端只负责调用，推理全部在 Python GPU 上跑
 */

import { ui } from './state.svelte';
import { markBackendSpawned } from './samBackendStatus';

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

// ====== 文本提示词处理 ======
// SAM3 的文本编码器是英文语料训练的，直接送中文（如「花朵」）基本出不来结果。
// 这里做一层常用词映射：命中就换成英文再发；没命中就原样发送，交给后端处理。
const PROMPT_ZH_TO_EN: Record<string, string> = {
  '人': 'person', '行人': 'person', '人脸': 'face', '男人': 'man', '女人': 'woman', '小孩': 'child',
  '花': 'flower', '花朵': 'flower', '鲜花': 'flower', '花草': 'flower',
  '树': 'tree', '树木': 'tree', '草': 'grass', '草地': 'grass',
  '狗': 'dog', '小狗': 'dog', '猫': 'cat', '小猫': 'cat', '鸟': 'bird', '马': 'horse',
  '牛': 'cow', '羊': 'sheep', '猪': 'pig', '鸡': 'chicken', '鱼': 'fish',
  '蝴蝶': 'butterfly', '蜜蜂': 'bee', '动物': 'animal',
  '车': 'car', '汽车': 'car', '轿车': 'car', '卡车': 'truck', '公交车': 'bus',
  '自行车': 'bicycle', '摩托车': 'motorcycle', '火车': 'train', '飞机': 'airplane', '船': 'boat',
  '房子': 'house', '房屋': 'house', '建筑': 'building', '楼': 'building', '桥': 'bridge',
  '门': 'door', '窗': 'window', '窗户': 'window', '墙': 'wall',
  '桌子': 'table', '椅子': 'chair', '沙发': 'couch', '床': 'bed', '柜子': 'cabinet',
  '杯子': 'cup', '瓶子': 'bottle', '碗': 'bowl', '盘子': 'plate',
  '手机': 'cell phone', '电脑': 'laptop', '笔记本': 'laptop', '键盘': 'keyboard',
  '鼠标': 'mouse', '显示器': 'monitor', '电视': 'tv', '耳机': 'headphone', '相机': 'camera',
  '书': 'book', '包': 'bag', '背包': 'backpack', '帽子': 'hat', '鞋': 'shoe',
  '衣服': 'clothes', '眼镜': 'glasses', '口罩': 'mask', '手表': 'watch',
  '苹果': 'apple', '香蕉': 'banana', '橘子': 'orange', '橙子': 'orange',
  '西瓜': 'watermelon', '水果': 'fruit', '蔬菜': 'vegetable', '食物': 'food',
  '蛋糕': 'cake', '面包': 'bread',
  '天空': 'sky', '云': 'cloud', '山': 'mountain', '河': 'river', '水': 'water',
  '海': 'sea', '沙滩': 'beach', '路': 'road', '灯': 'lamp', '钟': 'clock',
};

/** 中文提示词 → 英文；不含中文或无法翻译时原样返回 */
export function normalizePrompt(text: string): string {
  const src = (text || '').trim();
  if (!src) return src;
  const exact = PROMPT_ZH_TO_EN[src];
  if (exact) return exact;
  if (!/[\u4e00-\u9fa5]/.test(src)) return src;    // 本来就是英文/数字

  // 长词优先替换，避免「花朵」被「花」先吃掉
  const keys = Object.keys(PROMPT_ZH_TO_EN).sort((a, b) => b.length - a.length);
  let out = src;
  for (const k of keys) out = out.split(k).join(PROMPT_ZH_TO_EN[k]);
  // 还残留中文就说明没翻译全，原样发出去（让后端/模型自己处理）
  return /[\u4e00-\u9fa5]/.test(out) ? src : out;
}

/** 给 UI 用：当前提示词是否会被自动翻译 */
export function promptNeedsTranslation(text: string): boolean {
  const src = (text || '').trim();
  return !!src && /[\u4e00-\u9fa5]/.test(src);
}

// ====== Python 后端配置 ======
let SAM_SERVER_URL = 'http://127.0.0.1:1421';

/** fetch 包装：把「Failed to fetch」这种底层网络错误翻译成能照着做的提示。
 *  浏览器只在网络层失败时抛这个（后端没起、端口不对、被防火墙拦），
 *  跟提示词是中文还是英文完全没有关系。 */
async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e: any) {
    // 用户点「取消」时我们会 abort 请求，这种错误要原样抛给上层，不能当成「连不上后端」
    if (e && (e.name === 'AbortError' || e.code === 20)) throw e;
    throw new Error(
      `连不上 SAM 后端（${SAM_SERVER_URL}）。请先启动 Python 服务（sam_server.py），` +
      `看到控制台输出 SAM_SERVER_READY 后，再在「SAM 智能分割」弹窗里点「连接后端」。`
    );
  }
}

export async function ensureSidecar(): Promise<string> {
  const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__; if (!isTauri) return SAM_SERVER_URL;
  const { invoke } = await import('@tauri-apps/api/core');
  const port = await invoke<number>('sam_sidecar_start');
  SAM_SERVER_URL = 'http://127.0.0.1:' + port;
  ui.samBackendPort = port;
  // 已就绪时不要回退成「加载中」；只有刚 spawn 的情况才进入加载宽限期
  if (ui.samBackendState !== 'ready') markBackendSpawned(90_000);
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
  let modelNotReady = false;
  try {
    const resp = await safeFetch(`${SAM_SERVER_URL}/health`);
    const data = await resp.json();
    serverReady = data.model_loaded === true;
    ui.samPoseLoaded = data.pose_loaded === true;
    ui.samFaceLoaded = data.face_loaded === true;
    // 同步到 $state：组件的 `$derived(...)` 只认响应式依赖。
    // 以前界面读的是 isModelLoaded()，它读的是模块级普通变量，
    // Svelte 感知不到变化 → 连接成功了界面还是「未连接」，得关掉弹窗重开。
    ui.samModelReady = serverReady;
    if (!serverReady) {
      modelNotReady = true;
      ui.samBackendState = 'loading';
      throw new Error('后端在线，但模型还没加载完（首次约 10~30 秒），请稍候再点连接');
    }
    ui.samBackendState = 'ready';
    ui.samBackendError = '';
  } catch (e: any) {
    serverReady = false;
    ui.samModelReady = false;
    if (!modelNotReady) {
      ui.samBackendState = 'error';
      ui.samBackendError = e?.message || String(e);
    }
    throw new Error(e?.message || '无法连接 SAM 后端服务，请确认 Python 服务已启动');
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
    const resp = await safeFetch(`${SAM_SERVER_URL}/embed`, {
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
  const resp = await safeFetch(`${SAM_SERVER_URL}/predict`, {
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
  const prompt = normalizePrompt(text);

  // 1. 图片编码（复用缓存）
  const key = imageKey(image);
  if (cachedImageKey !== key) {
    const b64 = imageToBase64(image);
    const resp = await safeFetch(`${SAM_SERVER_URL}/embed`, {
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
  const resp = await safeFetch(`${SAM_SERVER_URL}/pcs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_id: cachedImageId,
      text: prompt,
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
  const resp = await safeFetch(`${SAM_SERVER_URL}/pose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_base64: b64, conf }),
  });
  if (!resp.ok) throw new Error(`姿态检测失败: ${resp.status}`);
  const data = await resp.json();
  ui.samPoseLoaded = true;
  ui.samBackendState = 'ready';
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
  const resp = await safeFetch(`${SAM_SERVER_URL}/face`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_base64: b64 }),
  });
  if (!resp.ok) throw new Error(`人脸检测失败: ${resp.status}`);
  const data = await resp.json();
  ui.samFaceLoaded = true;
  ui.samBackendState = 'ready';
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

/** 批量任务逐张回调，用于驱动进度条 */
export interface BatchTaskProgress {
  /** 已处理张数（1-based） */
  done: number;
  total: number;
  name: string;
  /** 这张图命中的实例/目标数 */
  count: number;
  elapsed_ms: number;
}

export interface BatchOptions {
  onProgress?: (p: BatchTaskProgress) => void | Promise<void>;
  /** 返回 true 时在当前图片处理完后停止 */
  shouldCancel?: () => boolean;
}

export interface BatchPcsResult {
  name: string;
  instances: PcsInstance[];
  count: number;
  elapsed_ms: number;
  /** 单张失败的原因；成功时为 undefined。批量不会因为一张失败就整体中断 */
  error?: string;
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

/** 图片 base64 → image_id（SAM3 编码，每张约 1~2s）。
 *  /pcs 与 /predict 都只认 image_id，所以批量必须逐张先 embed。 */
async function embedImageBase64(b64: string, signal?: AbortSignal): Promise<string> {
  const resp = await safeFetch(SAM_SERVER_URL + '/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_base64: b64 }),
    signal,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`图片编码失败 ${resp.status}${body ? ': ' + body.slice(0, 120) : ''}`);
  }
  const data = await resp.json();
  if (!data?.image_id) throw new Error('后端未返回 image_id');
  return data.image_id as string;
}

export async function batchPcs(
  dataUrls: string[],
  text: string,
  confidenceThreshold: number = 0.5,
  opts: BatchOptions = {}
): Promise<BatchPcsResult[]> {
  const results: BatchPcsResult[] = [];
  const total = dataUrls.length;
  const prompt = normalizePrompt(text);   // 中文提示词先转英文

  // 取消要「立刻」生效：轮询 shouldCancel，一旦置位就 abort 正在跑的那个请求，
  // 否则用户点取消后还得等当前这张 embed+pcs 跑完（大图可能十几秒），看着就像卡死。
  const ac = new AbortController();
  const watch = setInterval(() => { if (opts.shouldCancel?.()) ac.abort(); }, 150);

  try {
    for (let i = 0; i < total; i++) {
      if (opts.shouldCancel?.()) break;
      const t0 = Date.now();
      const name = 'img_' + i;

      try {
        const b64 = await urlToBase64(dataUrls[i]);
        if (opts.shouldCancel?.()) break;
        // 关键修复：先 /embed 拿 image_id。之前直接把 image_base64 发给 /pcs，
        // 而 PcsRequest 必填 image_id → 第一张就 422，整批中断。
        const imageId = await embedImageBase64(b64, ac.signal);
        if (opts.shouldCancel?.()) break;
        const resp = await safeFetch(SAM_SERVER_URL + '/pcs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_id: imageId, text: prompt, confidence_threshold: confidenceThreshold }),
          signal: ac.signal,
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          throw new Error(`文本分割失败 ${resp.status}${body ? ': ' + body.slice(0, 120) : ''}`);
        }
        const data = await resp.json();
        const insts = (data.instances || []).map((inst: any) => ({
          polygon: (inst.polygon || []).map((pt: number[]) => ({ x: pt[0], y: pt[1] })),
          score: inst.score || 0,
          box: { x1: inst.box?.[0] ?? 0, y1: inst.box?.[1] ?? 0, x2: inst.box?.[2] ?? 0, y2: inst.box?.[3] ?? 0 },
        }));
        const elapsed = Date.now() - t0;
        results.push({ name, count: insts.length, elapsed_ms: elapsed, instances: insts });
        await opts.onProgress?.({ done: i + 1, total, name, count: insts.length, elapsed_ms: elapsed });
      } catch (e: any) {
        if (e?.name === 'AbortError') break;   // 用户取消，直接结束整批
        // 单张失败不影响后续图片
        const elapsed = Date.now() - t0;
        results.push({ name, count: 0, elapsed_ms: elapsed, instances: [], error: e?.message || String(e) });
        await opts.onProgress?.({ done: i + 1, total, name, count: 0, elapsed_ms: elapsed });
      }
    }
  } finally {
    clearInterval(watch);
  }

  return results;
}
export interface BatchKpResult {
  name: string;
  objects: { keypoints: { x: number; y: number; conf?: number }[]; score: number }[];
  count: number;
  elapsed_ms: number;
  error?: string;
}

export async function batchKp(
  dataUrls: string[],
  model: 'pose' | 'face',
  conf: number = 0.25,
  opts: BatchOptions = {}
): Promise<BatchKpResult[]> {
  const results: BatchKpResult[] = [];
  const endpoint = model === 'pose' ? 'pose' : 'face';
  const total = dataUrls.length;

  const ac = new AbortController();
  const watch = setInterval(() => { if (opts.shouldCancel?.()) ac.abort(); }, 150);

  try {
    for (let i = 0; i < total; i++) {
      if (opts.shouldCancel?.()) break;
      const t0 = Date.now();
      const name = 'img_' + i;

      try {
        const b64 = await urlToBase64(dataUrls[i]);
        if (opts.shouldCancel?.()) break;
        const resp = await safeFetch(SAM_SERVER_URL + '/' + endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_base64: b64, conf }),
          signal: ac.signal,
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          throw new Error(`${model === 'pose' ? '姿态' : '人脸'}检测失败 ${resp.status}${body ? ': ' + body.slice(0, 120) : ''}`);
        }
        const data = await resp.json();
        const arr = data.persons || data.faces || [];
        const objs = arr.map((o: any) => ({ keypoints: (o.keypoints || []).map((k: number[]) => ({ x: k[0], y: k[1] })), score: o.score || 0 }));
        const elapsed = Date.now() - t0;
        results.push({ name, count: objs.length, elapsed_ms: elapsed, objects: objs });
        await opts.onProgress?.({ done: i + 1, total, name, count: objs.length, elapsed_ms: elapsed });
      } catch (e: any) {
        if (e?.name === 'AbortError') break;
        const elapsed = Date.now() - t0;
        results.push({ name, count: 0, elapsed_ms: elapsed, objects: [], error: e?.message || String(e) });
        await opts.onProgress?.({ done: i + 1, total, name, count: 0, elapsed_ms: elapsed });
      }
    }
  } finally {
    clearInterval(watch);
  }

  return results;
}
