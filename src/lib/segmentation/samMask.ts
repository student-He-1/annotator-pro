/** 分割模式专用 SAM3 客户端。
 *
 *  **`src/lib/sam.ts` 一行不改** —— 检测模式的那套客户端已经稳定（它上传 JPEG、
 *  只解析 polygon），分割模式需要的是「一张索引图 PNG + 原图分辨率的真掩膜」，
 *  上传也用 PNG 保证像素精确。宁可复制几条 fetch，也不动检测模式在用的代码。
 *
 *  后端契约见 图像分割模式-实施方案.md §5：
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
/** 同一张图只 embed 一次：SAM3 一次编码可以反复换提示词（几十毫秒一个词） */
let embeddedKey = '';
let embeddedId = '';

export function getSegBaseUrl(): string { return baseUrl; }
export function isSegServerReady(): boolean { return serverReady; }
export function isSegMaskSupported(): boolean { return maskSupported; }

function isTauri(): boolean {
  return typeof window !== 'undefined' && (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__);
}

/** 探测后端能力。桌面端会顺带尝试拉起 sidecar（和检测模式同一个命令）。
 *
 *  注意：`sam_sidecar_start` 找的是 **exe 同级 `sidecar/sam_server.py`**，
 *  而打包输出目录里并没有这个文件（方案 §3 修正 ①：sidecar 从未随 exe 发布）。
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

/** 切图时调用：丢掉 embed 缓存（后端 state 是另一回事，这里只是让下次重新 embed） */
export function clearSegSamCache() {
  embeddedKey = '';
  embeddedId = '';
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

async function ensureEmbedded(img: HTMLImageElement): Promise<string> {
  const key = imageKey(img);
  if (embeddedId && embeddedKey === key) return embeddedId;
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
  embeddedId = data.image_id as string;
  embeddedKey = key;
  return embeddedId;
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
  const imageId = await ensureEmbedded(img);
  const resp = await fetch(`${baseUrl}/pcs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_id: imageId,
      text,
      confidence_threshold: confidenceThreshold,
      return_mask: true,
    }),
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
    // 有实例却没有掩膜 = 后端版本太旧（方案 §5 之前的实现）
    maskSupported = false;
    throw new Error('后端没有返回 mask_png —— 当前的 sam_server.py 还不支持像素级掩膜，请更新后端（方案 §5）');
  }
  // instances.length === 0 且没有掩膜：这是**正常空结果**（这个词在这张图上没东西），
  // 不是错误，调用方会提示「没有分割出任何区域」。
  return { instances, map, width: img.naturalWidth, height: img.naturalHeight };
}

/** 点提示 → 单个实例掩膜（值 1） */
export async function predictWithMask(
  img: HTMLImageElement,
  x: number,
  y: number,
  label: 0 | 1 = 1
): Promise<{ map: Uint8Array | null; score: number; polygon: { x: number; y: number }[] }> {
  if (!serverReady) throw new Error('SAM 后端未连接：先点「连接后端」');
  const imageId = await ensureEmbedded(img);
  const resp = await fetch(`${baseUrl}/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_id: imageId, x, y, label, multimask: true, return_mask: true }),
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
