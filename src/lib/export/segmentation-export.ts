/** 分割模式导出（P1a：COCO 实例；P1b：Cityscapes 语义 / 实例掩膜 PNG / U-Net）。
 *
 *  为什么不写进 `formats.ts`：那个文件是检测/分类模式的导出实现（VOC/YOLO/COCO…），
 *  铁律 A 明确「不动现有导出 case」。分割模式的数据来自 masks，和 annotations 无关，
 *  单独一个文件、单独一组 `seg_*` 格式值，互不干扰。
 *
 *  统一套路：先 `buildLabelPixels()` 把索引图映射成一张 `Uint8Array(W*H)`，三种格式只有 `mapFn` 不同。
 */
import { images, ui } from '../state.svelte';
import { getImagesWithMasks, getMaskForExport, getImageMask } from '../segmentation/store.svelte';
import type { ImageMask, MaskRegion } from '../segmentation/types';
import { CITYSCAPES_TRAIN_ID } from '../segmentation/presets';
import { regionStats, rleBinaryColMajor } from '../segmentation/rle';

export type SegExportFormat =
  | 'seg_coco' | 'seg_coco_merged' | 'seg_cityscapes' | 'seg_instances' | 'seg_unet';

export interface SegExportFile {
  filename: string;
  /** 文本文件（JSON 等） */
  content?: string;
  /** 二进制文件（PNG）的 base64（不含 data: 前缀） */
  base64?: string;
  mimeType: string;
}

/** Cityscapes 的 void / ignore 标签 */
export const CITYSCAPES_VOID = 255;

function baseName(name: string): string {
  const file = name.split(/[\\/]/).pop() || name;
  return file.replace(/\.[^.]+$/, '');
}

// ============================================================
// 单通道灰度 PNG 编码（8-bit，color type 0）
// ============================================================
// 为什么不用 canvas：`toDataURL` 只会出 RGBA 图，语义分割的训练脚本要的是
// **单通道灰度 PNG**（PIL 里 mode 必须是 'L'、值就是 trainId）。
// Chromium 有 `CompressionStream('deflate')`（输出就是 PNG 需要的 zlib 流），
// 自己拼 IHDR/IDAT/IEND 比走 canvas 精确得多，也顺手避开了 canvas 的透明度/色彩空间问题。

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32be(data.length), 0);
  out.set(body, 4);
  out.set(u32be(crc32(body)), 4 + body.length);
  return out;
}

async function deflateZlib(raw: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('当前运行环境没有 CompressionStream，无法生成单通道 PNG（WebView2 应支持；若是旧版浏览器请升级）');
  }
  const cs = new CompressionStream('deflate');
  // 复制一份独立的 ArrayBuffer 交给 Blob：直接传 Uint8Array 在 TS 5.7+ 的类型里是
  // Uint8Array<ArrayBufferLike>，与 BlobPart 要求的 ArrayBufferView<ArrayBuffer> 不兼容
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const stream = new Blob([buf]).stream().pipeThrough(cs);
  const out = await new Response(stream).arrayBuffer();
  return new Uint8Array(out);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Uint8Array（行主序，长度 = w*h）→ 8-bit 灰度 PNG 的 base64 */
export async function encodeGrayPng(width: number, height: number, pixels: Uint8Array): Promise<string> {
  if (pixels.length !== width * height) {
    throw new Error(`标签图长度 ${pixels.length} 与 ${width}x${height} 不一致`);
  }
  // 每行前面加一个 filter 字节（0 = None）
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * width;
    const dst = y * (width + 1);
    raw[dst] = 0;
    raw.set(pixels.subarray(src, src + width), dst + 1);
  }
  const idat = await deflateZlib(raw);
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 0;    // color type 0 = 灰度
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const png = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { png.set(p, off); off += p.length; }
  return bytesToBase64(png);
}

// ============================================================
// 索引图 → 标签图（三种导出的公共前半段）
// ============================================================
function buildLabelPixels(
  mask: ImageMask,
  map: Uint8Array,
  mapFn: (region: MaskRegion) => number,
  background: number,
): Uint8Array {
  const w = mask.width;
  const h = mask.height;
  const out = new Uint8Array(w * h);
  out.fill(background);
  // ordinal → 标签值的 LUT（不逐像素查对象）
  const lut = new Uint8Array(256);
  const assigned = new Uint8Array(256);
  for (const region of mask.regions) {
    if (region.hidden) continue;
    const v = mapFn(region);
    lut[region.ordinal & 255] = v & 255;
    assigned[region.ordinal & 255] = 1;
  }
  for (let i = 0; i < map.length; i++) {
    const k = map[i];
    if (k && assigned[k]) out[i] = lut[k];
  }
  return out;
}

/** Cityscapes 语义标签：trainId(0..18)，未映射的类别与未标注像素都写 255(void)。
 *
 *  **绝不能写 0**：0 在 Cityscapes 里是 road，把「没标的地方」写成 0 等于告诉训练器
 *  那里全是路 —— 这是这个导出最容易犯、又最难看出来的错。 */
function cityscapesTrainId(region: MaskRegion): number {
  const override = ui.segCityscapesMap?.[region.className];
  if (typeof override === 'number') return override;
  const id = CITYSCAPES_TRAIN_ID[region.className.trim().toLowerCase()];
  return typeof id === 'number' ? id : CITYSCAPES_VOID;
}

/** 当前掩膜里「Cityscapes 映射不到」的类别（面板要提示，否则导出的语义图里它们会变成 void） */
export function getUnmappedCityscapesClasses(mask: ImageMask | undefined): string[] {
  if (!mask) return [];
  const out = new Set<string>();
  for (const r of mask.regions) {
    if (r.hidden) continue;
    if (cityscapesTrainId(r) === CITYSCAPES_VOID) out.add(r.className);
  }
  return [...out];
}

// ============================================================
// COCO 实例 JSON
// ============================================================
function buildCoco(names: string[]): { content: string; imageCount: number; annCount: number } {
  const categories = ui.segClasses.map((name, i) => ({ id: i + 1, name, supercategory: 'none' }));
  const catIdOf = new Map<string, number>();
  categories.forEach(c => catIdOf.set(c.name, c.id));

  const outImages: any[] = [];
  const outAnns: any[] = [];
  let annId = 1;

  for (const name of names) {
    const got = getMaskForExport(name);
    if (!got) continue;
    const { mask, map } = got;
    const imageId = outImages.length + 1;
    const imgData = images.find(i => i.name === name);
    outImages.push({
      id: imageId,
      file_name: imgData?.name || name,
      width: mask.width,
      height: mask.height,
    });

    for (const region of mask.regions) {
      if (region.kind !== 'instance' || region.hidden) continue;
      let catId = catIdOf.get(region.className);
      if (!catId) {
        catId = categories.length + 1;
        categories.push({ id: catId, name: region.className, supercategory: 'none' });
        catIdOf.set(region.className, catId);
      }
      const st = regionStats(map, mask.width, region.ordinal);
      if (st.area === 0 || !st.box) continue;
      const counts = rleBinaryColMajor(map, mask.width, mask.height, region.ordinal);
      outAnns.push({
        id: annId++,
        image_id: imageId,
        category_id: catId,
        segmentation: { counts, size: [mask.height, mask.width] },
        area: st.area,
        bbox: [st.box.x1, st.box.y1, st.box.x2 - st.box.x1, st.box.y2 - st.box.y1],
        iscrowd: 0,
      });
    }
  }

  const payload = {
    info: {
      description: 'Annotator Pro segmentation masks',
      date_created: new Date().toISOString(),
    },
    images: outImages,
    annotations: outAnns,
    categories,
  };
  // 紧凑输出：counts 动辄上千个数字，缩进会把文件体积放大 3~4 倍
  return { content: JSON.stringify(payload), imageCount: outImages.length, annCount: outAnns.length };
}

function cocoFile(names: string[], merged: boolean): SegExportFile | null {
  const { content, annCount } = buildCoco(names);
  if (annCount === 0 && !merged) {
    // 只有 stuff 区域时 COCO 会是空标注 —— 不是错误，照写，用户自己判断
  }
  const filename = merged ? 'annotations_masks.json' : `${baseName(names[0])}_masks.json`;
  return { filename, content, mimeType: 'application/json' };
}

// ============================================================
// 实例掩膜 PNG（平铺：indexmap + 逐实例二值图 + 清单）
// ============================================================
function safeName(s: string): string {
  return (s || 'object').trim().replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'object';
}

async function instanceFiles(name: string, includeDetails: boolean): Promise<SegExportFile[]> {
  const got = getMaskForExport(name);
  if (!got) return [];
  const { mask, map } = got;
  const base = baseName(name);
  const w = mask.width;
  const h = mask.height;
  const files: SegExportFile[] = [];

  // 索引图：0 = 背景，k = ordinal（和内存/工程里的表达一致，方便回头核对）
  const indexB64 = await encodeGrayPng(w, h, map);
  files.push({ filename: `${base}_indexmap.png`, base64: indexB64, mimeType: 'image/png' });

  if (!includeDetails) return files;

  const manifest: any[] = [];
  const instances = mask.regions.filter(r => r.kind === 'instance' && !r.hidden);
  for (const region of instances) {
    const st = regionStats(map, w, region.ordinal);
    if (st.area === 0) continue;
    const binary = new Uint8Array(w * h);
    for (let i = 0; i < map.length; i++) if (map[i] === region.ordinal) binary[i] = 255;
    const pad = String(region.ordinal).padStart(4, '0');
    const b64 = await encodeGrayPng(w, h, binary);
    files.push({ filename: `${base}_${pad}_${safeName(region.className)}.png`, base64: b64, mimeType: 'image/png' });
    manifest.push({
      ordinal: region.ordinal,
      className: region.className,
      kind: region.kind,
      score: region.score,
      area: st.area,
      bbox: st.box ? [st.box.x1, st.box.y1, st.box.x2 - st.box.x1, st.box.y2 - st.box.y1] : null,
      maskFile: `${base}_${pad}_${safeName(region.className)}.png`,
    });
  }
  files.push({
    filename: `${base}_instances.json`,
    content: JSON.stringify({ image: name, width: w, height: h, indexmap: `${base}_indexmap.png`, instances: manifest }),
    mimeType: 'application/json',
  });
  return files;
}

// ============================================================
// 对外：单图 / 批量
// ============================================================
export async function getSegExportFiles(imageName: string, format: SegExportFormat): Promise<SegExportFile[]> {
  if (!getMaskForExport(imageName)) return [];
  switch (format) {
    case 'seg_coco': {
      const f = cocoFile([imageName], false);
      return f ? [f] : [];
    }
    case 'seg_coco_merged': {
      const f = cocoFile(getImagesWithMasks().map(i => i.name), true);
      return f ? [f] : [];
    }
    case 'seg_cityscapes': {
      const got = getMaskForExport(imageName)!;
      const pixels = buildLabelPixels(got.mask, got.map, cityscapesTrainId, CITYSCAPES_VOID);
      const b64 = await encodeGrayPng(got.mask.width, got.mask.height, pixels);
      return [{ filename: `${baseName(imageName)}_labelTrainIds.png`, base64: b64, mimeType: 'image/png' }];
    }
    case 'seg_unet': {
      const got = getMaskForExport(imageName)!;
      const pixels = buildLabelPixels(
        got.mask, got.map,
        r => Math.max(0, ui.segClasses.indexOf(r.className)) + 1,   // 1-based，0=背景（沿用 formats.ts 的 U-Net 约定）
        0,
      );
      const b64 = await encodeGrayPng(got.mask.width, got.mask.height, pixels);
      return [{ filename: `${baseName(imageName)}_unet_mask.png`, base64: b64, mimeType: 'image/png' }];
    }
    case 'seg_instances': {
      // 单图「另存为」只能落一个文件 → 只出索引图；逐实例 PNG + 清单走批量
      return instanceFiles(imageName, false);
    }
    default:
      return [];
  }
}

export async function getSegBatchFiles(format: SegExportFormat): Promise<SegExportFile[]> {
  const names = getImagesWithMasks().map(i => i.name);
  if (names.length === 0) return [];
  switch (format) {
    case 'seg_coco_merged': {
      const f = cocoFile(names, true);
      return f ? [f] : [];
    }
    case 'seg_instances': {
      const out: SegExportFile[] = [];
      for (const name of names) out.push(...(await instanceFiles(name, true)));
      return out;
    }
    case 'seg_coco':
    case 'seg_cityscapes':
    case 'seg_unet': {
      const out: SegExportFile[] = [];
      for (const name of names) out.push(...(await getSegExportFiles(name, format)));
      return out;
    }
    default:
      return [];
  }
}

/** 面板上「导出」下拉的选项 */
export const SEG_EXPORT_FORMATS: { value: SegExportFormat; label: string }[] = [
  { value: 'seg_coco', label: 'COCO 实例 JSON（每图一个）' },
  { value: 'seg_coco_merged', label: 'COCO 实例 JSON（合并一个）' },
  { value: 'seg_cityscapes', label: 'Cityscapes 语义 PNG（trainId）' },
  { value: 'seg_instances', label: '实例掩膜 PNG（索引图+逐实例）' },
  { value: 'seg_unet', label: 'U-Net Mask PNG' },
];

/** 统计一句话，导出前给用户看。
 *  注意：这里**不解码整图**（面板每次重渲染都会调它，解码 2 MB/张会卡）。 */
export function describeMasks(): string {
  const entries = getImagesWithMasks();
  let instances = 0;
  let stuff = 0;
  for (const e of entries) {
    const mask = getImageMask(e.name);
    if (!mask) continue;
    for (const r of mask.regions) {
      if (r.hidden) continue;
      if (r.kind === 'instance') instances++; else stuff++;
    }
  }
  return `${entries.length} 张图 · ${instances} 个实例区域 · ${stuff} 个整片(stuff)区域`;
}

/** 给统计弹窗用：按类别统计区域数 */
export function getSegClassRegionCounts(mask: ImageMask): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of mask.regions) {
    if (r.hidden) continue;
    out[r.className] = (out[r.className] || 0) + 1;
  }
  return out;
}
