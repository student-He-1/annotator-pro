/** 分割模式专用 SAM3 客户端。
 *
 *  **`src/lib/sam.ts` 一行不改** —— 检测模式的那套客户端已经稳定（它上传 JPEG、
 *  只解析 polygon），分割模式需要的是「一张索引图 PNG + 原图分辨率的真掩膜」，
 *  上传也用 PNG 保证像素精确。宁可复制几条 fetch，也不动检测模式在用的代码。
 *
 *  后端契约：
 *    GET  /health   → features: ["mask"]（缺省视为旧后端，优雅降级）
 *    POST /pcs      → return_mask=true 时多返回 mask_png（一张索引图，值 k = instances[k-1]）
 *    POST /predict  → return_mask=true 时多返回 mask_png（单实例二值 0/255）
 */
import { ensureSidecar } from '../sam';

const DEFAULT_BASE = 'http://127.0.0.1:1421';

export interface SegInstance {
  polygon: { x: number; y: number }[];
  score: number;
  box: { x1: number; y1: number; x2: number; y2: number };
}

export interface SegMaskResponse {
  instances: SegInstance[];
  /** 与 instances 同序的索引图：值 k 对应 instances[k-1]；解码失败/旧后端时为 null */
  map: Uint8Array | null;
  width: number;
  height: number;
}

let baseUrl = DEFAULT_BASE;
let serverReady = false;
let maskSupported = false;
/** embed 结果的**多图 LRU**（方案 P2：以前只有一个槽，切图必重编码 1~2 s）。
 *  imageKey → image_id。留 4 张：后端 `state_cache` 默认留 5 张，前端少留一张，
 *  正常情况下回到前几张图就是 0 成本；万一后端把它挤掉了，请求会 404 → 自动重新 embed 一次。 */
const EMBED_LRU_MAX = 4;
const embedCache = new Map<string, string>();   // Map 的插入顺序就是 LRU 顺序
/** 本次会话真正发过多少次 /embed（面板显示 + E2E 断言「切回来不再重编码」用） */
let embedRequests = 0;

export function getSegBaseUrl(): string { return baseUrl; }
export function isSegServerReady(): boolean { return serverReady; }
export function isSegMaskSupported(): boolean { return maskSupported; }

/** 当前缓存了几张图的编码（UI 显示用） */
export function getSegEmbedCacheSize(): number {
  return embedCache.size;
}

/** 本次会话累计 /embed 次数 */
export function getSegEmbedRequestCount(): number {
  return embedRequests;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__);
}

/** 探测后端能力。桌面端会顺带尝试拉起 sidecar（和检测模式同一个命令）。
 *
 *  注意：`sam_sidecar_start` 找的是 **exe 同级 `sidecar/sam_server.py`**，
 *  而打包输出目录里并没有这个文件（sidecar 从未随 exe 发布）。
 *  所以这里绝不能「拉起失败就直接报错」——照文档手动起的后端还在 1421 上跑着，
 *  正确做法是忽略拉起失败，继续探测 /health。 */
export async function connectSegBackend(startSidecar = true): Promise<{ ready: boolean; maskSupported: boolean; error?: string }> {
  if (startSidecar && isTauri()) {
    try {
      const url = await ensureSidecar();
      if (url) baseUrl = url;
    } catch {
      // 拉起失败（exe 同级没有 sidecar 脚本是常态）→ 退回到「直接探测已手动启动的后端」
    }
  }
  try {
    const resp = await fetch(`${baseUrl}/health`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    serverReady = data?.model_loaded === true;
    const features: string[] = Array.isArray(data?.features) ? data.features : [];
    maskSupported = features.includes('mask');
    if (!serverReady) {
      return { ready: false, maskSupported, error: '后端在线但模型还没加载完（冷启动 10~30 秒）' };
    }
    return { ready: true, maskSupported };
  } catch (e: any) {
    serverReady = false;
    maskSupported = false;
    return {
      ready: false,
      maskSupported: false,
      error:
        `连不上 SAM 后端（${baseUrl}）。请先手动启动 Python 服务：\n` +
        `python src-tauri\\sidecar\\sam_server.py，看到 SAM_SERVER_READY 再点「连接后端」。（${e?.message || e}）`,
    };
  }
}

/** 清空 embed 缓存（一般只在明确切后端/断线时用；切图**不要**清，多图 LRU 就是为了切图不重编码） */
export function clearSegSamCache() {
  embedCache.clear();
}

function imageKey(img: HTMLImageElement): string {
  return `${img.src}_${img.naturalWidth}x${img.naturalHeight}`;
}

/** HTMLImageElement → PNG base64。
 *  检测模式上传的是 JPEG q=0.95（有损，掩膜边缘会被压缩噪点啃掉几个像素）；
 *  分割模式走 PNG，像素级精确。 */
function imageToPngBase64(img: HTMLImageElement): string {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL('image/png').split(',')[1];
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** PNG 索引图 → Uint8Array（取 R 通道）。
 *  必须关掉 imageSmoothing，否则缩放会混出「不存在的 ordinal」。 */
async function decodePngToMap(b64: string, wantW: number, wantH: number, binary: boolean): Promise<Uint8Array> {
  const blob = base64ToBlob(b64, 'image/png');
  const bmp = await createImageBitmap(blob);
  const w = bmp.width;
  const h = bmp.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bmp, 0, 0);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  (bmp as any).close?.();

  if (wantW > 0 && wantH > 0 && (w !== wantW || h !== wantH)) {
    throw new Error(`后端返回的掩膜尺寸 ${w}x${h} 与原图 ${wantW}x${wantH} 不一致（后端没按原图分辨率合成）`);
  }

  const map = new Uint8Array(w * h);
  if (binary) {
    for (let i = 0, p = 0; i < map.length; i++, p += 4) map[i] = rgba[p] > 127 ? 1 : 0;
  } else {
    for (let i = 0, p = 0; i < map.length; i++, p += 4) map[i] = rgba[p];
  }
  return map;
}

async function embedRequest(img: HTMLImageElement): Promise<string> {
  embedRequests++;
  const b64 = imageToPngBase64(img);
  const resp = await fetch(`${baseUrl}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_base64: b64 }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`图片编码失败 ${resp.status}${body ? ': ' + body.slice(0, 120) : ''}`);
  }
  const data = await resp.json();
  if (!data?.image_id) throw new Error('后端没有返回 image_id');
  return data.image_id as string;
}

async function ensureEmbedded(img: HTMLImageElement): Promise<string> {
  const key = imageKey(img);
  const hit = embedCache.get(key);
  if (hit) {
    // 命中后移到队尾（Map 的插入顺序当 LRU）
    embedCache.delete(key);
    embedCache.set(key, hit);
    return hit;
  }
  const id = await embedRequest(img);
  embedCache.set(key, id);
  while (embedCache.size > EMBED_LRU_MAX) {
    const oldest = embedCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    embedCache.delete(oldest);
  }
  return id;
}

/** 带 embed 的 POST。
 *  后端的 `state_cache` 默认只留 5 张，前端 LRU 留 4 张，正常情况下不会落空；
 *  但万一后端把它挤掉了（比如别的地方也调了 /embed），请求会 404 —— 这时丢掉缓存重新 embed 再试一次，
 *  用户看到的是「稍微慢一下」，而不是「点完没反应」。 */
async function postWithEmbed(
  img: HTMLImageElement,
  path: string,
  extra: Record<string, unknown>
): Promise<Response> {
  const key = imageKey(img);
  let imageId = await ensureEmbedded(img);
  const send = (id: string) => fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...extra, image_id: id }),
  });
  let resp = await send(imageId);
  if (resp.status === 404) {
    embedCache.delete(key);
    imageId = await ensureEmbedded(img);
    resp = await send(imageId);
  }
  return resp;
}

function normalizeInstances(list: any[]): SegInstance[] {
  return (list || []).map((inst: any) => ({
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

/** 文本提示 → 实例 + 索引图掩膜 */
export async function pcsWithMask(
  img: HTMLImageElement,
  text: string,
  confidenceThreshold = 0.3
): Promise<SegMaskResponse> {
  if (!serverReady) throw new Error('SAM 后端未连接：先点「连接后端」');
  const resp = await postWithEmbed(img, '/pcs', {
    text,
    confidence_threshold: confidenceThreshold,
    return_mask: true,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`文本分割失败 ${resp.status}${body ? ': ' + body.slice(0, 160) : ''}`);
  }
  const data = await resp.json();
  const instances = normalizeInstances(data.instances);
  let map: Uint8Array | null = null;
  if (data.mask_png) {
    map = await decodePngToMap(data.mask_png, img.naturalWidth, img.naturalHeight, false);
    // 后端滤掉了多边形点数 < 3 的实例，索引图是按过滤后的顺序编的号；
    // 这里再核对一次最大值，异常时明确报出来，别静默丢区域。
    let maxK = 0;
    for (let i = 0; i < map.length; i++) if (map[i] > maxK) maxK = map[i];
    if (maxK > instances.length) {
      console.warn(`[segmentation] 索引图最大值 ${maxK} > 实例数 ${instances.length}，多出来的值 ${instances.length + 1}..${maxK} 会被忽略`);
    }
  } else if (instances.length > 0) {
    // 有实例却没有掩膜 = 后端版本太旧（旧版只返回 polygon）
    maskSupported = false;
    throw new Error('后端没有返回 mask_png —— 当前的 sam_server.py 还不支持像素级掩膜，请更新后端（需要 return_mask）');
  }
  // instances.length === 0 且没有掩膜：这是**正常空结果**（这个词在这张图上没东西），
  // 不是错误，调用方会提示「没有分割出任何区域」。
  return { instances, map, width: img.naturalWidth, height: img.naturalHeight };
}

export interface SegPoint { x: number; y: number; label: 0 | 1 }

/** 多点多标签提示 → 单个实例掩膜（值 1）。
 *  负点修正就是靠它：正点=要保留，负点=要排除；后端 `predict_inst` 的 point_coords/labels
 *  本来就吃多组点，所以这里只是把单点扩展成点列表（老调用方走 predictWithMask 不受影响）。 */
export async function predictWithPoints(
  img: HTMLImageElement,
  points: SegPoint[]
): Promise<{ map: Uint8Array | null; score: number; polygon: { x: number; y: number }[] }> {
  if (!serverReady) throw new Error('SAM 后端未连接：先点「连接后端」');
  if (points.length === 0) return { map: null, score: 0, polygon: [] };
  const resp = await postWithEmbed(img, '/predict', {
    points: points.map(p => [p.x, p.y]),
    labels: points.map(p => p.label),
    multimask: true,
    return_mask: true,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`点分割失败 ${resp.status}${body ? ': ' + body.slice(0, 160) : ''}`);
  }
  const data = await resp.json();
  const polygon: { x: number; y: number }[] = (data.polygon || []).map((pt: number[]) => ({ x: pt[0], y: pt[1] }));
  let map: Uint8Array | null = null;
  if (data.mask_png) {
    map = await decodePngToMap(data.mask_png, img.naturalWidth, img.naturalHeight, true);
  }
  return { map, score: data.score || 0, polygon };
}

/** 点提示 → 单个实例掩膜（值 1） */
export async function predictWithMask(
  img: HTMLImageElement,
  x: number,
  y: number,
  label: 0 | 1 = 1
): Promise<{ map: Uint8Array | null; score: number; polygon: { x: number; y: number }[] }> {
  return predictWithPoints(img, [{ x, y, label }]);
}
