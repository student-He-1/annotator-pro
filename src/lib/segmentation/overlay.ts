/** 分割掩膜的离屏 overlay 合成（纯函数，不依赖任何全局状态）。
 *
 *  为什么不在 render() 里逐像素画：一张 1920×1080 的图 = 200 万像素，
 *  鼠标一动就重算会直接把交互拖到卡死。这里只在「掩膜/选中/透明度变了」时
 *  重建一次离屏 canvas，render() 里只做一次 drawImage。
 *
 *  坐标系直接按原图尺寸铺（不画到屏幕），由 engine 缩放到「图片中心为原点」的坐标系里。
 */
import type { ImageMask, MaskCandidate } from './types';

export interface OverlayInput {
  width: number;
  height: number;
  /** 正式索引图：0=背景，k=region */
  map: Uint8Array | null;
  mask: ImageMask | null;
  /** 候选索引图：0=无候选，k=候选序号 */
  candMap: Uint8Array | null;
  candidates: MaskCandidate[];
  /** 已被用户丢弃的候选（值不再画） */
  hiddenCandidates: Set<number>;
  selected: number;
  mode: 'instance' | 'class';
  opacity: number;
  showOverlay: boolean;
  showCandidate: boolean;
  colorOf: (className: string) => string;
}

const INSTANCE_PALETTE = [
  '#4da3ff', '#4ade80', '#fbbf24', '#f87171', '#a78bfa', '#36d1c4',
  '#db6dab', '#f0b429', '#8b949e', '#58a6ff', '#3fb950', '#d2991d',
];

function hexToRgb(hex: string): [number, number, number] {
  const h = (hex || '').replace('#', '').trim();
  if (h.length === 3) {
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  }
  if (h.length >= 6) {
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  return [139, 148, 158];
}

export function buildOverlayCanvas(input: OverlayInput): HTMLCanvasElement | null {
  const { width, height, map, mask, candMap, candidates, hiddenCandidates } = input;
  if (!width || !height) return null;
  if (!input.showOverlay && !input.showCandidate) return null;
  if (!map && !candMap) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(width, height);
  const out = new Uint32Array(imageData.data.buffer);

  // Little-endian：0xAABBGGRR
  const rgba = (r: number, g: number, b: number, a: number) =>
    ((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);

  // ---- 正式区域 ----
  if (input.showOverlay && map && mask) {
    // 按 ordinal 预先把颜色算成一张 256 项 LUT，避免每个像素都查对象/解析颜色
    const lut = new Uint32Array(256);
    for (const region of mask.regions) {
      if (region.hidden) continue;
      const k = region.ordinal & 255;
      const hex = input.mode === 'class'
        ? input.colorOf(region.className)
        : INSTANCE_PALETTE[(region.ordinal - 1) % INSTANCE_PALETTE.length];
      const [r, g, b] = hexToRgb(hex);
      const isSel = region.ordinal === input.selected;
      const baseAlpha = Math.max(0, Math.min(1, input.opacity));
      const a = Math.round((isSel ? Math.min(1, baseAlpha + 0.3) : baseAlpha) * 255);
      lut[k] = rgba(r, g, b, a);
    }
    for (let i = 0; i < map.length; i++) {
      const v = map[i];
      if (v) {
        const c = lut[v & 255];
        if (c) out[i] = c;
      }
    }
  }

  // ---- 候选（半透明黄色系，画在正式区域之上）----
  if (input.showCandidate && candMap) {
    const candLut = new Uint32Array(256);
    for (const cand of candidates) {
      if (hiddenCandidates.has(cand.k)) continue;
      const k = cand.k & 255;
      // 候选统一用暖色，和「已接受的正式区域」在视觉上分开
      const [r, g, b] = cand.k % 2 === 0 ? [251, 191, 36] : [56, 189, 248];
      candLut[k] = rgba(r, g, b, 110);
    }
    for (let i = 0; i < candMap.length; i++) {
      const v = candMap[i];
      if (!v) continue;
      const c = candLut[v & 255];
      if (c) out[i] = c;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}
