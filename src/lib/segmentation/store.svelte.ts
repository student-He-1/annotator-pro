/** 分割模式的存储层：索引图 / 事务编码 / 候选 / 独立撤销栈 / overlay 缓存。
 *
 *  设计约束：分割模式的所有新状态都走独立命名空间 ——
 *  数据存在本文件的 `maskMap` 里（**不进 $state**，2 MB 级数组不能被深代理包住），
 *  UI 状态走 `ui.mask* / ui.seg*`，和 `annotations` 零交叉：
 *  分割模式下 `annotations[name]` 恒为空，所以检测/分类的渲染、导出、统计、
 *  撤销逻辑天然碰不到掩膜数据。
 */
import { ui, images, imageModified, showToast, markModified, saveAnnotations, registerMaskPersistence } from '../state.svelte';
import { normalizePrompt } from '../sam';
import { DEFAULT_SEG_COLORS, SEG_PRESETS, SEG_ZH_TO_EN, STUFF_CLASSES, colorForNewSegClass, inferKind } from './presets';
import {
  encodeRuns, decodeRuns, removeOrdinalInPlace, parseRunString, runStringOf, measureOverlapPixels,
  mergeIndexRuns, unionIndexRuns, collectOverwritten,
} from './rle';
import { buildOverlayCanvas } from './overlay';
import { pcsWithMask, predictWithPoints, predictWithBox, clearSegSamCache, connectSegBackend, isSegMaskSupported, isSegBoxSupported, isSegServerReady } from './samMask';
import type { ImageMask, MaskCandidate, MaskRegion, MaskRegionKind, ProjectMask, SegmentationSettings, SegSweepResult } from './types';

const MAX_MASK_HISTORY = 30;
const MAX_DECODED = 2;

/** 掩膜的本地缓存（和检测/分类的标注共用一套保存键与自动保存语义）。
 *
 *  localStorage 的额度约 5 MB（按字符算），标注数据还要共用同一份额度，
 *  所以这里给掩膜留 2.5 MB 预算：超了**不写**、状态栏保持「未保存」并明确提示改用「保存工程」。
 *  宁可显示未保存，也不要谎报已保存。 */
const MASK_STORAGE_KEY = 'annotator_masks';
const MASK_LS_BUDGET = 2.5 * 1024 * 1024;
/** 有掩膜改动还没写进本地缓存（也覆盖「删图把掩膜删掉」这种非区域级改动） */
let storageDirty = false;

/** 真值：图片 name → 掩膜（紧凑形态） */
const maskMap = new Map<string, ImageMask>();
/** 解码后的整图，LRU 最多留 2 张（2 MB/张）。绝不放进 $state。 */
const decodeCache = new Map<string, Uint8Array>();

// ============================================================
// 候选（文本/点提示的返回，尚未接受）
// ============================================================
let candidates: MaskCandidate[] = [];
let candMap: Uint8Array | null = null;
let candW = 0;
let candH = 0;
const hiddenCandidates = new Set<number>();

// ============================================================
// 独立撤销栈（绝不和检测模式的 ui.history 混用）
// ============================================================
interface MaskSnap { name: string; mask: ImageMask | null }
const undoStack: MaskSnap[] = [];
const redoStack: MaskSnap[] = [];

// overlay 缓存：只在掩膜/选中/样式变化时重建
let overlayCache: { key: string; canvas: HTMLCanvasElement } | null = null;

// ============================================================
// 基础工具
// ============================================================
function currentName(): string {
  return images[ui.currentImageIndex]?.name || '';
}

function bump() {
  ui.maskRev = (ui.maskRev || 0) + 1;
  overlayCache = null;
}

function cloneMask(mask: ImageMask): ImageMask {
  return {
    width: mask.width,
    height: mask.height,
    counts: [...mask.counts],
    ids: [...mask.ids],
    regions: mask.regions.map(r => ({ ...r })),
  };
}

function emptyMask(width: number, height: number): ImageMask {
  return { width, height, counts: [], ids: [], regions: [] };
}

function cacheDecoded(name: string, map: Uint8Array) {
  decodeCache.delete(name);
  decodeCache.set(name, map);
  while (decodeCache.size > MAX_DECODED) {
    const oldest = decodeCache.keys().next().value as string;
    if (oldest === undefined) break;
    decodeCache.delete(oldest);
  }
}

/** 取某张图的解码索引图（不改变状态，只读缓存）。 */
export function peekDecodedMap(name: string): Uint8Array | null {
  return decodeCache.get(name) || null;
}

function getDecodedFor(name: string): Uint8Array | null {
  const cached = decodeCache.get(name);
  if (cached) return cached;
  const mask = maskMap.get(name);
  if (!mask) return null;
  const map = decodeRuns(mask.counts, mask.ids, mask.width * mask.height);
  cacheDecoded(name, map);
  return map;
}

function storeMask(name: string, mask: ImageMask, map: Uint8Array | null, opts: { silent?: boolean } = {}) {
  const enc = map ? encodeRuns(map) : { counts: [...mask.counts], ids: [...mask.ids] };
  maskMap.set(name, { ...mask, counts: enc.counts, ids: enc.ids });
  if (map) cacheDecoded(name, map);
  else decodeCache.delete(name);
  if (!opts.silent) markMaskDirty(name);
  refreshMeta();
  bump();
}

/** 标记「这张图的掩膜有改动」。
 *
 *  刻意**复用**检测/分类那套保存链路（`markModified` → `imageModified` → 500 ms 防抖 → `saveAnnotationsNow`），
 *  于是：工具栏「保存标注」按钮、Ctrl+S、状态栏「已保存/未保存」三种模式行为完全一致，
 *  不再出现「分割模式永远显示未保存、按保存键还没反应」。
 *  批量扫描会改到**非当前图**，那条路径走 `markMaskDirtyFor`（直接写 imageModified[name]）。 */
function markMaskDirty(name: string) {
  storageDirty = true;
  if (name) ui.maskDirty[name] = true;
  if (name && name === currentName()) {
    markModified();
  } else {
    markMaskDirtyFor(name);
  }
}

/** 非当前图（批量扫描）的脏标记：不能走 markModified（它只认当前图） */
function markMaskDirtyFor(name: string) {
  storageDirty = true;
  if (!name) return;
  ui.maskDirty[name] = true;
  imageModified[name] = true;
  saveAnnotations();
}

function refreshMeta() {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const [name, mask] of maskMap) {
    const n = mask.regions.length;
    counts[name] = n;
    total += n;
  }
  ui.maskCounts = counts;
  ui.maskTotal = total;
}

// ============================================================
// 读取接口
// ============================================================
export function getImageMask(name: string): ImageMask | undefined {
  ui.maskRev;   // 建立响应式依赖
  return maskMap.get(name);
}

export function getCurrentMask(): ImageMask | undefined {
  return getImageMask(currentName());
}

export function getRegionCount(name: string): number {
  ui.maskRev;
  return maskMap.get(name)?.regions.length || 0;
}

export function getRegions(name: string): MaskRegion[] {
  ui.maskRev;
  return maskMap.get(name)?.regions || [];
}

export function getCandidates(): MaskCandidate[] {
  ui.maskRev;
  return candidates;
}

export function getSelectedRegion(): number {
  return ui.segSelectedRegion || 0;
}

export function colorOfSegClass(className: string): string {
  return ui.segClassColors?.[className] || DEFAULT_SEG_COLORS[className] || '#8b949e';
}

/** 分割模式自己的类别表（不写进检测/分类在用的 classes） */
export function ensureSegClass(className: string): string {
  const name = (className || '').trim();
  if (!name) return classFallback();
  if (!ui.segClasses.includes(name)) {
    ui.segClasses = [...ui.segClasses, name];
    ui.segClassColors = {
      ...ui.segClassColors,
      [name]: DEFAULT_SEG_COLORS[name] || colorForNewSegClass(ui.segClasses.length),
    };
    // 类别表要落进本地缓存，否则重启 exe 后新增类别会消失（检测/分类的 classes 一直是这么做的）
    saveAnnotations();
  }
  return name;
}

function classFallback(): string {
  return ui.segClasses[0] || 'object';
}

// ============================================================
// 撤销 / 重做（独立栈，只记当前图片）
// ============================================================
function snapshotOf(name: string): MaskSnap {
  const mask = maskMap.get(name);
  return { name, mask: mask ? cloneMask(mask) : null };
}

function checkpoint(name: string) {
  undoStack.push(snapshotOf(name));
  if (undoStack.length > MAX_MASK_HISTORY) undoStack.shift();
  redoStack.length = 0;
}

function applySnap(snap: MaskSnap) {
  if (!snap.mask) {
    maskMap.delete(snap.name);
    decodeCache.delete(snap.name);
  } else {
    maskMap.set(snap.name, cloneMask(snap.mask));
    decodeCache.delete(snap.name);
  }
  refreshMeta();
  bump();
}

export function canUndoMask(): boolean {
  ui.maskRev;
  return undoStack.length > 0;
}

export function canRedoMask(): boolean {
  ui.maskRev;
  return redoStack.length > 0;
}

export function undoMask(): boolean {
  const snap = undoStack.pop();
  if (!snap) return false;
  redoStack.push(snapshotOf(snap.name));
  applySnap(snap);
  if (ui.segSelectedRegion > (maskMap.get(snap.name)?.regions.length || 0)) ui.segSelectedRegion = 0;
  return true;
}

export function redoMask(): boolean {
  const snap = redoStack.pop();
  if (!snap) return false;
  undoStack.push(snapshotOf(snap.name));
  applySnap(snap);
  return true;
}

// ============================================================
// 文本提示 → 候选
// ============================================================
/** 中文 → 英文提示词：先查分割模式自己的驾驶词表，再退回 sam.ts 的通用表。
 *  两张表都不认识就原样发（SAM3 是开放词汇，本来就可以随便敲）。 */
function normalizeSegPrompt(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return s;
  const exact = SEG_ZH_TO_EN[s];
  if (exact) return exact;
  if (!/[\u4e00-\u9fa5]/.test(s)) return s;   // 本来就是英文
  const keys = Object.keys(SEG_ZH_TO_EN).sort((a, b) => b.length - a.length);
  let out = s;
  for (const k of keys) out = out.split(k).join(SEG_ZH_TO_EN[k]);
  if (!/[\u4e00-\u9fa5]/.test(out)) return out;
  return normalizePrompt(s);
}

function resolveClassName(prompt: string): string {
  const raw = prompt.trim();
  if (!raw) return classFallback();
  if (ui.segClasses.includes(raw)) return raw;
  const en = normalizeSegPrompt(raw).trim();
  if (ui.segClasses.includes(en)) return en;
  // 大小写/空格归一后用已有的类别名（road vs Road）
  const lower = en.toLowerCase();
  const hit = ui.segClasses.find(c => c.toLowerCase() === lower);
  return hit || en || raw;
}

export async function runTextPrompt(text: string): Promise<void> {
  const img = ui.currentImage;
  const name = currentName();
  if (!name || !img) { showToast('请先选择一张图片', 'error'); return; }
  const prompt = (text || '').trim();
  if (!prompt) return;

  ui.segPromptRunning = true;
  try {
    if (!isSegServerReady() || !isSegMaskSupported()) {
      const st = await connectSegBackend(true);
      ui.segBackendReady = st.ready;
      ui.segMaskSupported = st.maskSupported;
      if (!st.ready) { showToast(st.error || '后端未就绪', 'error'); return; }
    }
    const res = await pcsWithMask(img, normalizeSegPrompt(prompt) || prompt, ui.segConfThreshold);
    ui.segMaskSupported = isSegMaskSupported();

    const total = res.width * res.height;
    const className = resolveClassName(prompt);
    // 单遍统计每个 k 的像素数（别对每个候选各扫一遍 200 万像素）
    const areas = new Uint32Array(256);
    if (res.map) for (let i = 0; i < res.map.length; i++) { const v = res.map[i]; if (v) areas[v]++; }

    const list: MaskCandidate[] = [];
    res.instances.forEach((inst, idx) => {
      const k = idx + 1;
      // 索引图是 8 位（uint8）：k 超过 255 会回绕，宁可截断也不要把不同实例画成同一块
      if (k > 255) return;
      const area = areas[k] || 0;
      if (area === 0) return;   // 索引图里没这块像素（编号对不上），别显示一个空候选
      list.push({
        k,
        className,
        kind: inferKind(className, area / total),
        score: inst.score,
        area,
        box: inst.box,
      });
    });

    candidates = list;
    candMap = res.map;
    candW = res.width;
    candH = res.height;
    hiddenCandidates.clear();
    ui.segSelectedRegion = 0;
    bump();

    if (list.length === 0) {
      showToast(`「${className}」没有分割出任何区域（阈值 ${ui.segConfThreshold}，可调低再试）`, 'info');
    } else {
      const stuff = list.filter(c => c.kind === 'stuff').length;
      showToast(
        `「${className}」→ ${list.length} 个候选（${list.length - stuff} 实例 / ${stuff} 整片）；接受或丢弃后可直接敲下一个词`,
        'success'
      );
    }
  } catch (e: any) {
    showToast('分割失败：' + (e?.message || e), 'error');
  } finally {
    ui.segPromptRunning = false;
  }
}

/** 点/框提示共用的收尾：把返回的单实例掩膜变成候选列表里的 `k=1`。 */
function applySingleCandidate(
  res: { map: Uint8Array | null; score: number },
  img: HTMLImageElement,
  label: string,
): void {
  if (!res.map) {
    showToast(`后端没有返回掩膜（旧后端），${label}暂时不可用`, 'error');
    return;
  }
  const total = img.naturalWidth * img.naturalHeight;
  let area = 0;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  const W = img.naturalWidth;
  for (let i = 0; i < res.map.length; i++) {
    if (!res.map[i]) continue;
    area++;
    const y = (i / W) | 0;
    const x = i - y * W;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const className = ensureSegClass(ui.segActiveClass || classFallback());
  const cand: MaskCandidate = {
    k: 1,
    className,
    kind: inferKind(className, area / total),
    score: res.score,
    area,
    box: area > 0 ? { x1: minX, y1: minY, x2: maxX + 1, y2: maxY + 1 } : undefined,
  };
  candidates = [cand];
  candMap = res.map;
  candW = img.naturalWidth;
  candH = img.naturalHeight;
  hiddenCandidates.clear();
  bump();
  showToast(`${label}：${className}，${area} px（score ${res.score.toFixed(3)}）`, area > 0 ? 'success' : 'error');
}

/** 后端没连上时先连一次；失败给出提示并返回 false */
async function ensureSegReady(): Promise<boolean> {
  if (isSegServerReady() && isSegMaskSupported()) return true;
  const st = await connectSegBackend(true);
  ui.segBackendReady = st.ready;
  ui.segMaskSupported = st.maskSupported;
  if (!st.ready) { showToast(st.error || '后端未就绪', 'error'); return false; }
  return true;
}

export async function runPointPrompt(x: number, y: number, label: 0 | 1 = 1): Promise<void> {
  const img = ui.currentImage;
  const name = currentName();
  if (!name || !img) { showToast('请先选择一张图片', 'error'); return; }
  ui.segPromptRunning = true;
  try {
    if (!(await ensureSegReady())) return;
    const res = await predictWithPoints(img, [{ x: Math.round(x), y: Math.round(y), label }]);
    applySingleCandidate(res, img, '点分割');
  } catch (e: any) {
    showToast('点分割失败：' + (e?.message || e), 'error');
  } finally {
    ui.segPromptRunning = false;
  }
}

/** 把任意方向/越界的框规范成 `x1<x2, y1<y2` 且夹在图片内（纯函数，框提示与测试共用） */
export function normalizeBox(
  x1: number, y1: number, x2: number, y2: number,
  width: number, height: number,
): { x1: number; y1: number; x2: number; y2: number } {
  return {
    x1: Math.max(0, Math.min(x1, x2)),
    y1: Math.max(0, Math.min(y1, y2)),
    x2: Math.min(width, Math.max(x1, x2)),
    y2: Math.min(height, Math.max(y1, y2)),
  };
}

/** 框提示：在目标外面拉一个框 → SAM 只在这个范围内抠掩膜。
 *  适合目标边界模糊、或一簇同类物体文字提示会连成一片的情况。 */
export async function runBoxPrompt(
  x1: number, y1: number, x2: number, y2: number,
): Promise<void> {
  const img = ui.currentImage;
  const name = currentName();
  if (!name || !img) { showToast('请先选择一张图片', 'error'); return; }
  const box = normalizeBox(x1, y1, x2, y2, img.naturalWidth, img.naturalHeight);
  if (box.x2 - box.x1 < 3 || box.y2 - box.y1 < 3) {
    showToast('框太小了，至少要 3×3 像素', 'info');
    return;
  }
  ui.segPromptRunning = true;
  try {
    if (!(await ensureSegReady())) return;
    if (!isSegBoxSupported()) {
      showToast('当前后端不支持框提示（旧版 sam_server.py）—— 请重启最新后端再试', 'error');
      return;
    }
    const res = await predictWithBox(img, box);
    applySingleCandidate(res, img, '框分割');
  } catch (e: any) {
    showToast('框分割失败：' + (e?.message || e), 'error');
  } finally {
    ui.segPromptRunning = false;
  }
}

export function discardCandidate(k: number) {
  hiddenCandidates.add(k);
  candidates = candidates.filter(c => c.k !== k);
  bump();
}

export function discardAllCandidates() {
  for (const c of candidates) hiddenCandidates.add(c.k);
  candidates = [];
  candMap = null;
  bump();
}

export function clearCandidates() {
  if (candidates.length === 0 && !candMap) return;
  candidates = [];
  candMap = null;
  hiddenCandidates.clear();
  candW = 0;
  candH = 0;
  bump();
}

// ============================================================
// 接受候选 → 写进正式索引图
// ============================================================
export function acceptCandidate(k: number, className?: string, kind?: MaskRegionKind) {
  acceptCandidates([k], className, kind);
}

export function acceptAllCandidates() {
  // 面积大的先铺：整片的 road 垫底，小实例（车/人）叠在上面，
  // 单索引图的覆盖语义就是「后写覆盖先写」。
  const ks = [...candidates].sort((a, b) => b.area - a.area).map(c => c.k);
  acceptCandidates(ks);
}

function acceptCandidates(ks: number[], className?: string, kind?: MaskRegionKind) {
  const name = currentName();
  if (!name) { showToast('请先选择一张图片', 'error'); return; }
  if (!candMap || ks.length === 0) return;

  const items = ks
    .map(k => candidates.find(c => c.k === k))
    .filter((c): c is MaskCandidate => !!c)
    .map(c => ({
      k: c.k,
      className: className || c.className,
      kind: kind || c.kind,
      score: c.score,
      box: c.box,
      area: c.area,
    }));

  const added = applyCandidateItems(name, candMap, candW, candH, items, { checkpoint: true });
  if (!added) return;

  for (const k of ks) discardCandidateSilent(k);
  discardCandidateSilentCleanup();
  bump();
  showToast(`已接受 ${added} 个区域（共 ${maskMap.get(name)?.regions.length || 0} 个）`, 'success');
}

interface CandidateItem {
  k: number;
  className: string;
  kind: MaskRegionKind;
  score: number;
  box?: { x1: number; y1: number; x2: number; y2: number };
  area?: number;
}

/** 把一组候选并进某张图的正式索引图（单遍完成：写像素 + 累计面积/包围盒）。
 *
 *  `checkpoint`：是否记一个撤销点。一键扫描整轮只想留**一个**撤销点，
 *  所以只有第一次合并时传 true，其余传 false。
 *  `silent`：是否触发自动保存。扫描期间逐词保存会反复写几 MB 的本地缓存，留到最后统一触发。 */
function applyCandidateItems(
  name: string,
  candMap: Uint8Array,
  w: number,
  h: number,
  items: CandidateItem[],
  opts: { checkpoint?: boolean; silent?: boolean } = {},
): number | null {
  if (!w || !h || items.length === 0) return null;

  let mask = maskMap.get(name);
  if (mask && (mask.width !== w || mask.height !== h)) {
    showToast(`这张图已有 ${mask.width}x${mask.height} 的掩膜，与当前图尺寸不一致，已跳过`, 'error');
    return null;
  }
  if (!mask) mask = emptyMask(w, h);
  if (mask.regions.length + items.length > 255) {
    showToast('单图最多 255 个区域（索引图是 8 位）；请先删掉一些区域', 'error');
    return null;
  }

  // 一张图只记一次撤销点（扫描整轮 = 一个 Ctrl+Z）：
  // `checkpoint` 缺省 true（普通接受候选），扫描里只有第一次合并传 true，其余传 false
  if (opts.checkpoint !== false) checkpoint(name);

  const map = getDecodedFor(name) || new Uint8Array(w * h);
  const kToOrdinal = new Uint16Array(256);
  const existingCount = mask.regions.length;
  // 严格重叠（默认关闭）：记录候选会盖掉的**已有区域**像素，事后挂到旧区域上。
  // 关闭时这个 Map 始终为空，热路径只多一次布尔判断。
  const strict = ui.segStrictOverlap;
  const newRegions: ImageMask['regions'] = [];
  for (const it of items) {
    const ordinal = mask.regions.length + newRegions.length + 1;
    kToOrdinal[it.k & 255] = ordinal;
    newRegions.push({
      ordinal,
      className: ensureSegClass(it.className),
      kind: it.kind,
      score: it.score,
      source: 'pcs',
      box: it.box,
      area: 0,
    });
  }

  // 严格重叠：写入前先单独扫一遍，记下会被覆盖的已有区域像素（关闭时不做这次扫描）
  const occludedHits = strict
    ? collectOverwritten(candMap, map, k => kToOrdinal[k & 255], existingCount)
    : new Map<number, number[]>();

  // 单遍：写像素 + 同时累计每个新 ordinal 的面积与包围盒（省掉「每区域再扫一遍整图」）
  const areas = new Uint32Array(256);
  const minX = new Int32Array(256).fill(w);
  const minY = new Int32Array(256).fill(h);
  const maxX = new Int32Array(256).fill(-1);
  const maxY = new Int32Array(256).fill(-1);
  for (let i = 0; i < candMap.length; i++) {
    const v = candMap[i];
    if (!v) continue;
    const ord = kToOrdinal[v & 255];
    if (!ord) continue;
    map[i] = ord;
    const y = (i / w) | 0;
    const x = i - y * w;
    areas[ord]++;
    if (x < minX[ord]) minX[ord] = x;
    if (x > maxX[ord]) maxX[ord] = x;
    if (y < minY[ord]) minY[ord] = y;
    if (y > maxY[ord]) maxY[ord] = y;
  }
  for (const r of newRegions) {
    const o = r.ordinal;
    r.area = areas[o];
    r.box = areas[o] > 0 ? { x1: minX[o], y1: minY[o], x2: maxX[o] + 1, y2: maxY[o] + 1 } : r.box;
  }

  let regions = [...mask.regions, ...newRegions];
  if (strict && occludedHits.size > 0) {
    regions = regions.map(r => {
      const idx = occludedHits.get(r.ordinal);
      return idx ? { ...r, occluded: mergeIndexRuns(r.occluded, idx) } : r;
    });
  }
  storeMask(name, { width: w, height: h, counts: [], ids: [], regions }, map, { silent: opts.silent });
  return newRegions.length;
}

/** 重叠检测（只读）：这批候选如果被接受，会覆盖多少**已有区域**的像素。
 *  ks 缺省 = 当前所有候选。用于接受前的提示，不改变任何状态。 */
export function measureCandidateOverlap(name: string, ks?: number[]): { px: number; regions: number } {
  const res = { px: 0, regions: 0 };
  const mask = maskMap.get(name);
  if (!name || !mask || !candMap) return res;
  const map = getDecodedFor(name);
  if (!map) return res;
  // 只统计当前还在候选列表里的 k（candMap 里可能残留已丢弃/隐藏的候选）
  const only = new Set<number>(ks && ks.length > 0 ? ks : candidates.map(c => c.k));
  return measureOverlapPixels(candMap, map, only);
}

/** 小目标过滤：丢弃面积小于 minPx 的候选（不动已接受的区域） */
export function filterSmallCandidates(minPx: number): number {
  const min = Math.max(0, Math.round(minPx));
  if (min <= 0) { showToast('请先填写面积阈值（px）', 'info'); return 0; }
  const small = candidates.filter(c => c.area < min);
  if (small.length === 0) {
    showToast(`没有小于 ${min.toLocaleString()} px 的候选`, 'info');
    return 0;
  }
  for (const c of small) discardCandidateSilent(c.k);
  discardCandidateSilentCleanup();
  showToast(`已过滤 ${small.length} 个小于 ${min.toLocaleString()} px 的候选`, 'success');
  return small.length;
}

function discardCandidateSilent(k: number) {
  hiddenCandidates.add(k);
  candidates = candidates.filter(c => c.k !== k);
}

function discardCandidateSilentCleanup() {
  if (candidates.length === 0) {
    candMap = null;
    hiddenCandidates.clear();
  }
  bump();
}

// ============================================================
// 区域编辑
// ============================================================
export function deleteRegion(ordinal: number) {
  const name = currentName();
  const mask = maskMap.get(name);
  if (!mask) return;
  const idx = mask.regions.findIndex(r => r.ordinal === ordinal);
  if (idx < 0) return;

  const map = getDecodedFor(name);
  if (!map) return;

  checkpoint(name);
  removeOrdinalInPlace(map, ordinal);   // 删像素 + 后续 ordinal 递减（保证一一对应）
  const regions = mask.regions.filter(r => r.ordinal !== ordinal).map((r, i) => ({ ...r, ordinal: i + 1 }));
  storeMask(name, { width: mask.width, height: mask.height, counts: [], ids: [], regions }, map);
  if (ui.segSelectedRegion === ordinal) ui.segSelectedRegion = 0;
  showToast('已删除区域（Ctrl+Z 可撤销）', 'info');
}

export function deleteSelectedRegion() {
  const ord = ui.segSelectedRegion;
  if (!ord) return;
  deleteRegion(ord);
}

/** 小目标过滤：一次性删除当前图中面积小于 minPx 的区域（整批只记一个撤销点）。
 *  面积从索引图现场统计，不依赖 region.area 是否过期。 */
export function deleteSmallRegions(minPx: number): number {
  const min = Math.max(0, Math.round(minPx));
  const name = currentName();
  const mask = maskMap.get(name);
  const map = mask ? getDecodedFor(name) : null;
  if (min <= 0) { showToast('请先填写面积阈值（px）', 'info'); return 0; }
  if (!name || !mask || !map) { showToast('这张图还没有掩膜', 'info'); return 0; }

  const st = statsOfAll(map, mask.width, mask.height);
  const small = new Set(mask.regions.filter(r => (st.areas[r.ordinal & 255] || 0) < min).map(r => r.ordinal));
  if (small.size === 0) {
    showToast(`没有小于 ${min.toLocaleString()} px 的区域`, 'info');
    return 0;
  }
  if (small.size === mask.regions.length) {
    showToast(`所有区域都小于 ${min.toLocaleString()} px，已取消（避免整图删空）`, 'error');
    return 0;
  }

  checkpoint(name);
  for (let i = 0; i < map.length; i++) {
    if (small.has(map[i])) map[i] = 0;
  }
  finalizeMaskEdit(name);   // 重新编号 + 更新面积/包围盒 + 落盘
  if (small.has(ui.segSelectedRegion)) ui.segSelectedRegion = 0;
  showToast(`已删除 ${small.size} 个小于 ${min.toLocaleString()} px 的区域（Ctrl+Z 可撤销）`, 'success');
  return small.size;
}

// ---- 区域拆分（画一刀） ----
/** 用一条线段把 `ordinal` 区域切成两块（或多块连通块）。
 *
 *  做法：先在索引图**副本**上把线擦掉并统计连通块，确认确实切开了才动真数据 ——
 *  否则一条没切断的线会把区域划出一道缝，用户却以为拆分成功了。
 *  最大的一块保留原 ordinal（选中状态不变），其余每块新建一个区域；整次拆分只记一个撤销点。 */
export function splitRegionByLine(
  ordinal: number,
  x1: number, y1: number, x2: number, y2: number,
  cutWidth = 3,
): number {
  const name = currentName();
  const mask = maskMap.get(name);
  const map = mask ? getDecodedFor(name) : null;
  if (!name || !mask || !map || !ordinal) return 0;
  if (!mask.regions.some(r => r.ordinal === ordinal)) return 0;
  const w = mask.width, h = mask.height;

  // 沿线段按 1px 步长擦除一个小方块（宽 3px），保证 4 邻接也不会「漏过去」
  const rad = Math.max(1, Math.floor(cutWidth / 2));
  const cut = (target: Uint8Array) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = Math.round(x1 + (x2 - x1) * t);
      const cy = Math.round(y1 + (y2 - y1) * t);
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const px = cx + dx, py = cy + dy;
          if (px < 0 || py < 0 || px >= w || py >= h) continue;
          const i = py * w + px;
          if (target[i] === ordinal) target[i] = 0;
        }
      }
    }
  };

  // 1) 副本上试切 + 数连通块（把 work 当 visited 用：处理过的像素置 0）
  const work = map.slice();
  cut(work);
  const comps: { seed: number; size: number }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < work.length; i++) {
    if (work[i] !== ordinal) continue;
    let size = 0;
    work[i] = 0;
    stack.push(i);
    while (stack.length > 0) {
      const p = stack.pop()!;
      size++;
      const y = (p / w) | 0;
      const x = p - y * w;
      if (x > 0) { const q = p - 1; if (work[q] === ordinal) { work[q] = 0; stack.push(q); } }
      if (x < w - 1) { const q = p + 1; if (work[q] === ordinal) { work[q] = 0; stack.push(q); } }
      if (y > 0) { const q = p - w; if (work[q] === ordinal) { work[q] = 0; stack.push(q); } }
      if (y < h - 1) { const q = p + w; if (work[q] === ordinal) { work[q] = 0; stack.push(q); } }
    }
    comps.push({ seed: i, size });
  }

  if (comps.length < 2) {
    showToast('这条线没有把区域切开：请从区域外一侧拉到另一侧', 'info');
    return 0;
  }
  const totalAfter = mask.regions.length - 1 + comps.length;
  if (totalAfter > 255) {
    showToast(`拆分后会有 ${totalAfter} 个区域，超过单图 255 上限，已取消`, 'error');
    return 0;
  }

  // 2) 确认成功才动真数据：一次撤销点 + 擦除刀口
  checkpoint(name);
  cut(map);

  // 3) 最大块保留原 ordinal；其余块各自 flood 成新 ordinal
  comps.sort((a, b) => b.size - a.size);
  const region = mask.regions.find(r => r.ordinal === ordinal)!;
  const newRegions: MaskRegion[] = [];
  const paint = (seed: number, value: number) => {
    const st = [seed];
    map[seed] = value;
    while (st.length > 0) {
      const p = st.pop()!;
      const y = (p / w) | 0;
      const x = p - y * w;
      if (x > 0) { const q = p - 1; if (map[q] === ordinal) { map[q] = value; st.push(q); } }
      if (x < w - 1) { const q = p + 1; if (map[q] === ordinal) { map[q] = value; st.push(q); } }
      if (y > 0) { const q = p - w; if (map[q] === ordinal) { map[q] = value; st.push(q); } }
      if (y < h - 1) { const q = p + w; if (map[q] === ordinal) { map[q] = value; st.push(q); } }
    }
  };
  // 新区域不继承 occluded：被遮挡像素属于原实例，硬拷过去会让两个实例抢同一批像素
  const { occluded: _occ, ...regionBase } = region;
  for (let ci = 1; ci < comps.length; ci++) {
    const no = mask.regions.length + newRegions.length + 1;
    newRegions.push({ ...regionBase, ordinal: no });
    paint(comps[ci].seed, no);
  }

  // 4) 面积/包围盒按新索引图重算后落盘
  const st = statsOfAll(map, w, h);
  const regions = [...mask.regions, ...newRegions].map(r => {
    const o = r.ordinal & 255;
    return { ...r, area: st.areas[o], box: boxFromStats(st, r.ordinal) };
  });
  storeMask(name, { width: w, height: h, counts: [], ids: [], regions }, map);
  showToast(`已把区域 ${ordinal} 拆成 ${comps.length} 块（Ctrl+Z 可撤销）`, 'success');
  return comps.length;
}

export function setRegionClass(ordinal: number, className: string) {
  const name = currentName();
  const mask = maskMap.get(name);
  if (!mask) return;
  const region = mask.regions.find(r => r.ordinal === ordinal);
  if (!region) return;
  const cls = ensureSegClass(className);
  if (region.className === cls) return;
  checkpoint(name);
  const total = mask.width * mask.height;
  // 写时复制：regions 数组换成新引用。
  // 原地改 region.className 的话，数组引用没变 → Svelte 的 $derived 认为「值没变」，
  // 面板上的类别名/颜色不会刷新（构建不报错、但界面看着像点了没反应）。
  maskMap.set(name, {
    ...mask,
    regions: mask.regions.map(r => r.ordinal === ordinal
      ? { ...r, className: cls, kind: inferKind(cls, (r.area || 0) / (total || 1)) }
      : r),
  });
  markMaskDirty(name);
  refreshMeta();
  bump();
}

export function toggleRegionHidden(ordinal: number) {
  const name = currentName();
  const mask = maskMap.get(name);
  if (!mask) return;
  const region = mask.regions.find(r => r.ordinal === ordinal);
  if (!region) return;
  checkpoint(name);
  maskMap.set(name, {
    ...mask,
    regions: mask.regions.map(r => r.ordinal === ordinal ? { ...r, hidden: !r.hidden } : r),
  });
  markMaskDirty(name);
  refreshMeta();
  bump();
}

export function clearImageMask() {
  const name = currentName();
  if (!maskMap.has(name)) return;
  checkpoint(name);
  maskMap.delete(name);
  decodeCache.delete(name);
  markMaskDirty(name);
  ui.segSelectedRegion = 0;
  refreshMeta();
  bump();
}

// ============================================================
// 命中测试 / 选中
// ============================================================
export function selectRegion(ordinal: number) {
  ui.segSelectedRegion = ordinal;
  onRegionSelected();   // 换区域 = 换修正对象，提示点清零
  bump();
}

export function clearRegionSelection() {
  if (!ui.segSelectedRegion) return;
  ui.segSelectedRegion = 0;
  onRegionSelected();
  bump();
}

/** 点击图像坐标 → 该点落在哪个 region（查表，不做几何判断） */
export function hitTestRegion(imgX: number, imgY: number): number {
  const name = currentName();
  const mask = maskMap.get(name);
  if (!mask) return 0;
  const x = Math.floor(imgX);
  const y = Math.floor(imgY);
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return 0;
  const map = getDecodedFor(name);
  if (!map) return 0;
  return map[y * mask.width + x] || 0;
}

// ============================================================
// Overlay（离屏 canvas，按需重建）
// ============================================================
export function getSegOverlay(): HTMLCanvasElement | null {
  const name = currentName();
  if (!name) return null;
  const mask = maskMap.get(name) || null;
  const map = mask ? getDecodedFor(name) : null;
  const candCount = candidates.length;

  const key = [
    name, ui.maskRev, ui.segSelectedRegion, ui.segOverlayMode, ui.segOverlayOpacity,
    ui.segShowOverlay ? 1 : 0, ui.segShowCandidate ? 1 : 0, candCount, (map ? map.length : 0),
    ui.segHoverCandidate,
  ].join('|');
  if (overlayCache && overlayCache.key === key) return overlayCache.canvas;

  const w = mask?.width || candW;
  const h = mask?.height || candH;
  if (!w || !h) return null;

  const canvas = buildOverlayCanvas({
    width: w,
    height: h,
    map,
    mask,
    candMap,
    candidates,
    hiddenCandidates,
    selected: ui.segSelectedRegion,
    hoverCandidate: ui.segHoverCandidate,
    mode: ui.segOverlayMode,
    opacity: ui.segOverlayOpacity,
    showOverlay: ui.segShowOverlay,
    showCandidate: ui.segShowCandidate && candCount > 0,
    colorOf: colorOfSegClass,
  });
  overlayCache = canvas ? { key, canvas } : null;
  return canvas;
}

// ============================================================
// 后端 / 画布切换时的清理
// ============================================================
export async function checkSegBackend(): Promise<void> {
  const st = await connectSegBackend(true);
  ui.segBackendReady = st.ready;
  ui.segMaskSupported = st.maskSupported;
  if (!st.ready) showToast(st.error || '后端未就绪', 'error');
  else if (!st.maskSupported) showToast('后端在线，但版本太旧：没有 mask 能力（需要 return_mask / features）', 'error');
  else showToast('SAM3 后端已就绪（支持像素级掩膜）', 'success');
}

export function onImageSwitched() {
  clearCandidates();
  // 注意：**不清** embed 缓存了（P2 的多图 LRU）—— 切图回来是 0 成本，不用重编码 1~2 s
  ui.segSweepResults = [];
  ui.segSweepRunning = false;
  ui.segSweepCancel = false;
  ui.segSweepDone = 0;
  ui.segSweepTotal = 0;
  ui.segSweepCurrent = '';
  ui.segBatchRunning = false;
  ui.segBatchDone = 0;
  ui.segBatchTotal = 0;
  ui.segBatchCurrent = '';
  ui.segHoverCandidate = 0;
}

/** 候选 hover 预览（面板 onmouseenter/leave 调用） */
export function setHoverCandidate(k: number) {
  if (ui.segHoverCandidate === k) return;
  ui.segHoverCandidate = k;
  bump();
}

// ============================================================
// 一键全类扫描
// ============================================================
// SAM3 是 promptable 的：不给词它不会自己把图分割完。所以「一键识图」的正确形态是
// **拿一张类别词表逐词跑**（一次 embed 之后每词只要 200~600 ms），再按分数分层：
//   score ≥ 自动接受阈值 → 直接进正式掩膜；
//   [候选阈值, 自动接受阈值) → 只计数，点「复核」时再单独取回那一个词的候选；
//   < 候选阈值 → 后端就不会返回。
// 逐词「取回→合并→丢弃」是有意的：每个词的候选索引图是 2 MB，19 个词同时挂着就是 38 MB。

export function getSweepClasses(): string[] {
  return ui.segSweepClasses;
}

export function toggleSweepClass(className: string) {
  const list = ui.segSweepClasses;
  ui.segSweepClasses = list.includes(className)
    ? list.filter(c => c !== className)
    : [...list, className];
}

export function selectAllSweepClasses() {
  ui.segSweepClasses = [...ui.segClasses];
}

export function clearSweepClasses() {
  ui.segSweepClasses = [];
}

function presetKindOf(className: string): MaskRegionKind {
  const p = SEG_PRESETS.find(x => x.name === className);
  if (p) return p.kind;
  return STUFF_CLASSES.has(className.trim().toLowerCase()) ? 'stuff' : 'instance';
}

export function cancelClassSweep() {
  if (ui.segSweepRunning) ui.segSweepCancel = true;
}

function orderedSweepClasses(wanted: string[]): string[] {
  // stuff（road/sky）先铺底，thing（car/person）后叠上去 —— 单索引图是「后写覆盖先写」
  return [...wanted].sort(
    (a, b) => (presetKindOf(a) === 'stuff' ? 0 : 1) - (presetKindOf(b) === 'stuff' ? 0 : 1),
  );
}

interface SweepWordOutcome {
  result: SegSweepResult;
  accepted: number;
  checkpointed: boolean;
}

/** 对**一张图**跑一个词，高置信的直接合并。
 *  `allowCheckpoint`：这张图/这一轮是否还允许记撤销点（整轮只记第一个）。 */
async function sweepOneWord(
  img: HTMLImageElement,
  name: string,
  cls: string,
  allowCheckpoint: boolean,
): Promise<SweepWordOutcome> {
  const wordStart = performance.now();
  const elapsed = () => Math.round(performance.now() - wordStart);
  try {
    const res = await pcsWithMask(img, normalizeSegPrompt(cls) || cls, ui.segConfThreshold);
    if (!res.map || res.instances.length === 0) {
      return { result: { className: cls, total: 0, accepted: 0, review: 0, elapsedMs: elapsed() }, accepted: 0, checkpointed: false };
    }
    const areaLut = new Uint32Array(256);
    for (let i = 0; i < res.map.length; i++) { const v = res.map[i]; if (v) areaLut[v]++; }

    const auto: CandidateItem[] = [];
    let review = 0;
    // 同类内部按面积从大到小，小目标最后覆盖（避免被同类大 mask 吃掉）
    const idxs = res.instances.map((_, i) => i).sort((a, b) => (areaLut[b + 1] - areaLut[a + 1]));
    for (const i of idxs) {
      const k = i + 1;
      if (k > 255) continue;
      const area = areaLut[k] || 0;
      if (!area) continue;
      const inst = res.instances[i];
      if (inst.score >= ui.segSweepAutoAccept) {
        auto.push({ k, className: cls, kind: presetKindOf(cls), score: inst.score, box: inst.box, area });
      } else {
        review++;
      }
    }

    let accepted = 0;
    let checkpointed = false;
    if (auto.length > 0) {
      const added = applyCandidateItems(name, res.map, res.width, res.height, auto, {
        checkpoint: allowCheckpoint,
        silent: true,
      });
      if (added) { accepted = added; checkpointed = allowCheckpoint; }
    }
    return {
      result: { className: cls, total: auto.length + review, accepted, review, elapsedMs: elapsed() },
      accepted,
      checkpointed,
    };
  } catch (e: any) {
    return {
      result: { className: cls, total: 0, accepted: 0, review: 0, elapsedMs: elapsed(), error: e?.message || String(e) },
      accepted: 0,
      checkpointed: false,
    };
  }
}

export async function runClassSweep(onProgress?: () => void): Promise<void> {
  const img = ui.currentImage;
  const name = currentName();
  if (!name || !img) { showToast('请先选择一张图片', 'error'); return; }
  if (ui.segSweepRunning) return;

  const wanted = ui.segSweepClasses.filter(c => ui.segClasses.includes(c));
  if (wanted.length === 0) { showToast('先在「一键扫描」里勾选要扫的类别', 'error'); return; }

  ui.segSweepRunning = true;
  ui.segSweepCancel = false;
  ui.segSweepTotal = wanted.length;
  ui.segSweepDone = 0;
  ui.segSweepCurrent = '';
  ui.segSweepResults = [];
  const t0 = performance.now();
  let checkpointDone = false;
  let acceptedTotal = 0;
  let reviewTotal = 0;

  try {
    if (!isSegServerReady() || !isSegMaskSupported()) {
      const st = await connectSegBackend(true);
      ui.segBackendReady = st.ready;
      ui.segMaskSupported = st.maskSupported;
      if (!st.ready) { showToast(st.error || '后端未就绪', 'error'); ui.segSweepRunning = false; return; }
    }

    for (const cls of orderedSweepClasses(wanted)) {
      if (ui.segSweepCancel) break;
      ui.segSweepCurrent = cls;
      const out = await sweepOneWord(img, name, cls, !checkpointDone);
      if (out.checkpointed) checkpointDone = true;
      acceptedTotal += out.accepted;
      reviewTotal += out.result.review;
      ui.segSweepResults = [...ui.segSweepResults, out.result];
      ui.segSweepDone++;
      bump();
      // 逐词回调：让画布边扫边显示（store 不能 import engine，渲染由调用方传进来）
      try { onProgress?.(); } catch { /* 渲染失败不该打断扫描 */ }
    }
  } finally {
    ui.segSweepRunning = false;
    ui.segSweepCurrent = '';
    clearCandidates();
    if (checkpointDone) markMaskDirty(name);   // 扫描期间是 silent，这里统一触发一次自动保存
    bump();
  }

  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (ui.segSweepCancel) {
    showToast(`已取消：扫了 ${ui.segSweepDone}/${ui.segSweepTotal} 类，自动接受 ${acceptedTotal} 个区域（${secs}s）`, 'info');
  } else if (acceptedTotal === 0 && reviewTotal === 0) {
    showToast(`扫描完成（${secs}s）：勾选的 ${wanted.length} 类都没有命中，可调低阈值再试`, 'info');
  } else {
    showToast(
      `扫描完成（${secs}s）：自动接受 ${acceptedTotal} 个区域` +
      (reviewTotal > 0 ? `，另有 ${reviewTotal} 个待复核（点结果里的「复核」）` : ''),
      'success',
    );
  }
}

/** 整目录批量扫描（P2）：对**每张已导入的图**跑同一套词表。
 *
 *  严格说它不再是「整轮一个撤销点」—— 撤销栈是按图存的，所以**每张图各自一个撤销点**，
 *  切到那张图按 Ctrl+Z 只撤那张图。批量跨图撤销不做，避免把「合成一条跨图历史」的复杂度引进来。 */
export async function runBatchSweep(onProgress?: () => void): Promise<void> {
  if (ui.segSweepRunning) return;
  const wanted = ui.segSweepClasses.filter(c => ui.segClasses.includes(c));
  if (wanted.length === 0) { showToast('先在「一键扫描」里勾选要扫的类别', 'error'); return; }
  const targets = images.filter(i => i.dataUrl);
  if (targets.length === 0) { showToast('先导入图片', 'error'); return; }

  ui.segSweepRunning = true;
  ui.segSweepCancel = false;
  ui.segBatchRunning = true;
  ui.segBatchTotal = targets.length;
  ui.segBatchDone = 0;
  ui.segBatchCurrent = '';
  ui.segSweepResults = [];
  const ordered = orderedSweepClasses(wanted);
  const t0 = performance.now();
  const agg = new Map<string, SegSweepResult>();
  let acceptedTotal = 0;
  let reviewTotal = 0;
  let failed = 0;
  let processed = 0;

  try {
    if (!isSegServerReady() || !isSegMaskSupported()) {
      const st = await connectSegBackend(true);
      ui.segBackendReady = st.ready;
      ui.segMaskSupported = st.maskSupported;
      if (!st.ready) { showToast(st.error || '后端未就绪', 'error'); return; }
    }

    for (const info of targets) {
      if (ui.segSweepCancel) break;
      ui.segBatchCurrent = info.name;
      bump();
      try {
        const img = await loadImageEl(info.dataUrl);
        let checkpointDone = false;
        for (const cls of ordered) {
          if (ui.segSweepCancel) break;
          ui.segSweepCurrent = cls;
          const out = await sweepOneWord(img, info.name, cls, !checkpointDone);
          if (out.checkpointed) checkpointDone = true;
          acceptedTotal += out.accepted;
          reviewTotal += out.result.review;
          const a = agg.get(cls) || { className: cls, total: 0, accepted: 0, review: 0, elapsedMs: 0 };
          a.total += out.result.total;
          a.accepted += out.result.accepted;
          a.review += out.result.review;
          a.elapsedMs += out.result.elapsedMs;
          if (out.result.error) a.error = out.result.error;
          agg.set(cls, a);
          bump();
          try { onProgress?.(); } catch { /* 忽略 */ }
        }
        if (checkpointDone) markMaskDirtyFor(info.name);
        processed++;
      } catch (e: any) {
        failed++;
        console.warn('[segmentation] 批量扫描跳过这张图：', info.name, e);
      }
      ui.segBatchDone++;
      ui.segSweepResults = [...agg.values()];
      bump();
      try { onProgress?.(); } catch { /* 忽略 */ }
    }
  } finally {
    ui.segSweepRunning = false;
    ui.segBatchRunning = false;
    ui.segSweepCurrent = '';
    ui.segBatchCurrent = '';
    ui.segSweepResults = [...agg.values()];
    clearCandidates();
    bump();
  }

  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (ui.segSweepCancel) {
    showToast(`已取消：处理 ${processed}/${targets.length} 张，自动接受 ${acceptedTotal} 个区域（${secs}s）`, 'info');
  } else {
    showToast(
      `批量扫描完成（${secs}s）：${processed} 张图、自动接受 ${acceptedTotal} 个区域` +
      (reviewTotal > 0 ? `，${reviewTotal} 个待复核（逐张点「复核」）` : '') +
      (failed > 0 ? `，${failed} 张失败` : ''),
      failed > 0 ? 'error' : 'success',
    );
  }
}

function loadImageEl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}

/** 复核某个词：重新取一次它的候选，挂到现有的候选区（一次只挂一个词） */
export async function reviewSweepClass(className: string) {
  ui.segText = className;
  await runTextPrompt(className);
}

export function onImagesCleared() {
  clearCandidates();
  clearSegSamCache();
}

// ============================================================
// 工程文件持久化
// ============================================================
export function serializeMasks(): Record<string, ProjectMask> {
  const out: Record<string, ProjectMask> = {};
  for (const [name, mask] of maskMap) {
    if (mask.regions.length === 0) continue;
    out[name] = {
      width: mask.width,
      height: mask.height,
      counts: runStringOf(mask.counts),
      ids: runStringOf(mask.ids),
      regions: mask.regions.map(r => ({ ...r })),
    };
  }
  return out;
}

export function hasAnyMask(): boolean {
  for (const mask of maskMap.values()) if (mask.regions.length > 0) return true;
  return false;
}

export function loadMasksFromProject(masks: Record<string, ProjectMask> | undefined) {
  maskMap.clear();
  decodeCache.clear();
  undoStack.length = 0;
  redoStack.length = 0;
  clearCandidates();
  ui.maskDirty = {};
  ui.segSelectedRegion = 0;

  for (const [name, pm] of Object.entries(masks || {})) {
    if (!pm || !pm.width || !pm.height) continue;
    const regions = (pm.regions || []).map((r, i) => ({ ...r, ordinal: i + 1 }));
    maskMap.set(name, {
      width: pm.width,
      height: pm.height,
      counts: parseRunString(pm.counts),
      ids: parseRunString(pm.ids),
      regions,
    });
  }
  refreshMeta();
  bump();
}

export function serializeSegSettings(): SegmentationSettings {
  return {
    overlayMode: ui.segOverlayMode,
    overlayOpacity: ui.segOverlayOpacity,
    classes: [...ui.segClasses],
    classColors: { ...ui.segClassColors },
    cityscapesMap: { ...ui.segCityscapesMap },
    strictOverlap: ui.segStrictOverlap,
  };
}

export function loadSegSettings(s: SegmentationSettings | undefined) {
  if (!s) return;
  if (s.overlayMode === 'instance' || s.overlayMode === 'class') ui.segOverlayMode = s.overlayMode;
  if (typeof s.overlayOpacity === 'number') ui.segOverlayOpacity = s.overlayOpacity;
  if (typeof s.strictOverlap === 'boolean') ui.segStrictOverlap = s.strictOverlap;
  if (Array.isArray(s.classes) && s.classes.length > 0) ui.segClasses = [...s.classes];
  if (s.classColors) ui.segClassColors = { ...ui.segClassColors, ...s.classColors };
  if (s.cityscapesMap) ui.segCityscapesMap = { ...s.cityscapesMap };
}

export function markMasksSaved() {
  ui.maskDirty = {};
  storageDirty = false;
}

export function getMaskDirty(name: string): boolean {
  return !!ui.maskDirty[name];
}

/** 删图片时把它的掩膜也删掉（否则以后重新导入同名图片会「继承」上一次的掩膜）。 */
export function deleteImageMask(name: string) {
  if (!name) return;
  const had = maskMap.delete(name);
  decodeCache.delete(name);
  delete ui.maskDirty[name];
  refreshMeta();
  bump();
  if (had) {
    // 掩膜被删掉了，本地缓存也得跟着重写一次，否则重启后它会「复活」
    storageDirty = true;
    saveAnnotations();
  }
}

/** 有掩膜的图片（批量导出用；getExportData 在 annotations 为空时返回 null，不能复用） */
export function getImagesWithMasks(): { name: string; width: number; height: number }[] {
  ui.maskRev;
  // 只算「当前图片列表」里的掩膜：换文件夹后旧掩膜仍留在缓存里（重新导入同一文件夹可恢复），
  // 但不能混进当前文件夹的统计与批量导出。
  const current = new Set(images.map(i => i.name));
  const out: { name: string; width: number; height: number }[] = [];
  for (const [name, mask] of maskMap) {
    if (mask.regions.length > 0 && current.has(name)) out.push({ name, width: mask.width, height: mask.height });
  }
  return out;
}

/** 单图导出时拿到「区域 + 对应的解码图」 */
export function getMaskForExport(name: string): { mask: ImageMask; map: Uint8Array } | null {
  const mask = maskMap.get(name);
  if (!mask || mask.regions.length === 0) return null;
  const map = getDecodedFor(name);
  if (!map) return null;
  return { mask, map };
}

// ============================================================
// 修正工具：画笔 / 橡皮 / 负点修正 / 孤岛清理 / 合并
// ============================================================
// 一律遵守：改之前 `checkpoint()`（这样 Ctrl+Z 一步退回一次编辑），改完
// `finalizeMaskEdit()` 重算面积/包围盒并顺手把「被搓成 0 像素的区域」删掉。

interface AllStats {
  areas: Uint32Array;
  minX: Int32Array; minY: Int32Array; maxX: Int32Array; maxY: Int32Array;
}

/** 一遍扫完整张图，得到每个 ordinal 的面积与包围盒 */
function statsOfAll(map: Uint8Array, w: number, h: number): AllStats {
  const areas = new Uint32Array(256);
  const minX = new Int32Array(256).fill(w);
  const minY = new Int32Array(256).fill(h);
  const maxX = new Int32Array(256).fill(-1);
  const maxY = new Int32Array(256).fill(-1);
  for (let i = 0; i < map.length; i++) {
    const v = map[i];
    if (!v) continue;
    areas[v]++;
    const y = (i / w) | 0;
    const x = i - y * w;
    if (x < minX[v]) minX[v] = x;
    if (x > maxX[v]) maxX[v] = x;
    if (y < minY[v]) minY[v] = y;
    if (y > maxY[v]) maxY[v] = y;
  }
  return { areas, minX, minY, maxX, maxY };
}

function boxFromStats(st: AllStats, ordinal: number) {
  const o = ordinal & 255;
  if (!st.areas[o]) return undefined;
  return { x1: st.minX[o], y1: st.minY[o], x2: st.maxX[o] + 1, y2: st.maxY[o] + 1 };
}

/** 编辑收尾：重算统计、删掉空区域并重新编号（保证 ordinal 与 regions 下标一一对应）、落盘 */
function finalizeMaskEdit(name: string) {
  const mask = maskMap.get(name);
  const map = getDecodedFor(name);
  if (!mask || !map) return;
  const w = mask.width, h = mask.height;
  let st = statsOfAll(map, w, h);
  let regions = mask.regions;

  const anyEmpty = regions.some(r => st.areas[r.ordinal & 255] === 0);
  if (anyEmpty) {
    const remap = new Uint16Array(256);
    const kept: typeof regions = [];
    for (const r of regions) {
      if (st.areas[r.ordinal & 255] > 0) {
        const no = kept.length + 1;
        remap[r.ordinal & 255] = no;
        kept.push({ ...r, ordinal: no });
      }
    }
    for (let i = 0; i < map.length; i++) {
      const v = map[i];
      if (v) map[i] = remap[v] || 0;
    }
    regions = kept;
    if (ui.segSelectedRegion) ui.segSelectedRegion = remap[ui.segSelectedRegion & 255] || 0;
    st = statsOfAll(map, w, h);
  }

  regions = regions.map(r => {
    const o = r.ordinal & 255;
    return { ...r, area: st.areas[o], box: boxFromStats(st, r.ordinal) };
  });
  storeMask(name, { width: w, height: h, counts: [], ids: [], regions }, map);
}

// ---- 画笔 / 橡皮 ----
let strokeName = '';
let strokeCheckpointed = false;

/** 开始一笔（mousedown）。返回 false 表示这张图还没有掩膜，没什么可画的 */
export function beginMaskStroke(): boolean {
  const name = currentName();
  if (!name) return false;
  const mask = maskMap.get(name);
  if (!mask) { showToast('这张图还没有掩膜：先扫描/点提示出一个区域，再用画笔补', 'info'); return false; }
  strokeName = name;
  strokeCheckpointed = false;
  return true;
}

/** 笔刷要画到哪个 ordinal：选中区域 > 同类别最近区域 > 0（没有） */
export function brushTargetOrdinal(): number {
  const name = currentName();
  const mask = maskMap.get(name);
  if (!mask) return 0;
  if (ui.segSelectedRegion) {
    const r = mask.regions.find(x => x.ordinal === ui.segSelectedRegion);
    if (r) return r.ordinal;
  }
  const cls = ui.segActiveClass;
  const same = [...mask.regions].reverse().find(r => r.className === cls);
  return same ? same.ordinal : 0;
}

/** 没有目标区域时新建一个（用当前激活类别），这样不选区域也能直接补 */
export function ensureBrushRegion(): number {
  const name = currentName();
  const mask = maskMap.get(name);
  if (!mask) return 0;
  const existing = brushTargetOrdinal();
  if (existing) return existing;
  if (mask.regions.length >= 255) { showToast('单图最多 255 个区域', 'error'); return 0; }
  checkpoint(name);
  const ordinal = mask.regions.length + 1;
  const cls = ensureSegClass(ui.segActiveClass || classFallback());
  const regions = [
    ...mask.regions,
    { ordinal, className: cls, kind: inferKind(cls, 0), score: 0, source: 'brush' as const, area: 0 },
  ];
  storeMask(name, { width: mask.width, height: mask.height, counts: [], ids: [], regions }, getDecodedFor(name) || new Uint8Array(mask.width * mask.height));
  ui.segSelectedRegion = ordinal;
  return ordinal;
}

/** 在图像坐标 (x,y) 画一个半径 r 的圆：ordinal=0 就是橡皮 */
export function paintAt(x: number, y: number, radius: number, ordinal: number) {
  const name = strokeName || currentName();
  if (!name) return;
  const mask = maskMap.get(name);
  if (!mask) return;
  const map = getDecodedFor(name);
  if (!map) return;
  if (!strokeCheckpointed) {
    checkpoint(name);
    strokeCheckpointed = true;
  }
  const w = mask.width, h = mask.height;
  const r = Math.max(1, Math.round(radius));
  const cx = Math.round(x), cy = Math.round(y);
  const r2 = r * r;
  const y0 = Math.max(0, cy - r), y1 = Math.min(h - 1, cy + r);
  for (let yy = y0; yy <= y1; yy++) {
    const dy = yy - cy;
    const span = Math.floor(Math.sqrt(Math.max(0, r2 - dy * dy)));
    const x0 = Math.max(0, cx - span), x1 = Math.min(w - 1, cx + span);
    const row = yy * w;
    for (let xx = x0; xx <= x1; xx++) map[row + xx] = ordinal;
  }
  bump();   // 只 bump（overlay 用解码图重建），编码留到 endMaskStroke
}

export function endMaskStroke() {
  const name = strokeName || currentName();
  if (!name) return;
  strokeName = '';
  strokeCheckpointed = false;
  finalizeMaskEdit(name);
}

// ---- 负点修正 ----
export function getRefinePoints() {
  return ui.segRefinePoints;
}

export function clearRefinePoints() {
  ui.segRefinePoints = [];
  bump();
}

export function onRegionSelected() {
  // 换区域 = 换修正对象，累加的提示点要清掉，否则会把上一个区域的点带过来
  ui.segRefinePoints = [];
}

/** 给「当前选中区域」加一个提示点并立刻重新分割（正点=保留，负点=排除）。
 *  每一次点击都是一步可撤销的编辑（Ctrl+Z）。 */
export async function refineSelectedWithPoint(x: number, y: number, label: 0 | 1): Promise<void> {
  const name = currentName();
  const img = ui.currentImage;
  const mask = maskMap.get(name);
  if (!name || !img || !mask) { showToast('请先选择一张有掩膜的图片', 'error'); return; }
  const ordinal = ui.segSelectedRegion;
  if (!ordinal || !mask.regions.some(r => r.ordinal === ordinal)) {
    showToast('先在区域列表里点一个区域，再点提示修正', 'error');
    return;
  }
  ui.segPromptRunning = true;
  const points = [...ui.segRefinePoints, { x, y, label }];
  try {
    if (!isSegServerReady() || !isSegMaskSupported()) {
      const st = await connectSegBackend(true);
      ui.segBackendReady = st.ready;
      ui.segMaskSupported = st.maskSupported;
      if (!st.ready) { showToast(st.error || '后端未就绪', 'error'); return; }
    }
    const res = await predictWithPoints(img, points);
    if (!res.map) { showToast('后端没有返回掩膜', 'error'); return; }
    let area = 0;
    for (let i = 0; i < res.map.length; i++) if (res.map[i]) area++;
    if (area === 0) {
      showToast('这次修正把区域清空了，已忽略（先加一个正点试试）', 'error');
      return;
    }
    const map = getDecodedFor(name);
    if (!map) return;
    checkpoint(name);
    for (let i = 0; i < map.length; i++) if (map[i] === ordinal) map[i] = 0;
    for (let i = 0; i < res.map.length; i++) if (res.map[i]) map[i] = ordinal;
    ui.segRefinePoints = points;
    finalizeMaskEdit(name);
    bump();
    showToast(`已修正：${area.toLocaleString()} px · ${points.length} 个提示点（Ctrl+Z 可撤销这一次）`, 'success');
  } catch (e: any) {
    showToast('修正失败：' + (e?.message || e), 'error');
  } finally {
    ui.segPromptRunning = false;
  }
}

// ---- 孤岛清理 ----
/** 把每个区域里「小于 minPx 的孤立连通块」删掉（始终保留最大块，避免把整块删没） */
export function cleanupSmallIslands(minPx?: number) {
  const name = currentName();
  const mask = maskMap.get(name);
  const map = getDecodedFor(name);
  if (!name || !mask || !map) { showToast('这张图还没有掩膜', 'info'); return; }
  const w = mask.width, h = mask.height;
  const threshold = Math.max(1, Math.round(minPx ?? ui.segIslandMinPx));

  // 先算「哪些像素属于小连通块」，确认真的有得删再 checkpoint（否则撤销会像没反应）
  const compId = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  const biggestOf = new Map<number, number>();   // ordinal → 最大块 id
  let nextId = 0;
  const stack: number[] = [];
  for (let i = 0; i < map.length; i++) {
    if (!map[i] || compId[i] >= 0) continue;
    const o = map[i];
    const id = nextId++;
    let size = 0;
    let biggest = true;
    compId[i] = id;
    stack.push(i);
    while (stack.length > 0) {
      const p = stack.pop()!;
      size++;
      const y = (p / w) | 0;
      const x = p - y * w;
      if (x > 0) { const q = p - 1; if (map[q] === o && compId[q] < 0) { compId[q] = id; stack.push(q); } }
      if (x < w - 1) { const q = p + 1; if (map[q] === o && compId[q] < 0) { compId[q] = id; stack.push(q); } }
      if (y > 0) { const q = p - w; if (map[q] === o && compId[q] < 0) { compId[q] = id; stack.push(q); } }
      if (y < h - 1) { const q = p + w; if (map[q] === o && compId[q] < 0) { compId[q] = id; stack.push(q); } }
    }
    sizes[id] = size;
    const prev = biggestOf.get(o) ?? -1;
    if (prev < 0 || size > sizes[prev]) biggestOf.set(o, id);
    biggest = false;
  }
  const biggestIds = new Set<number>(biggestOf.values());
  const toClear: number[] = [];
  for (let i = 0; i < map.length; i++) {
    const id = compId[i];
    if (id < 0) continue;
    if (biggestIds.has(id)) continue;
    if (sizes[id] < threshold) toClear.push(i);
  }
  if (toClear.length === 0) {
    showToast(`没有小于 ${threshold} px 的孤立小块`, 'info');
    return;
  }
  checkpoint(name);
  for (const i of toClear) map[i] = 0;
  finalizeMaskEdit(name);
  bump();
  showToast(`清掉了 ${toClear.length.toLocaleString()} px 的孤立小块（Ctrl+Z 可撤销）`, 'success');
}

// ---- 合并区域 ----
/** 把 from 区域并进 to 区域（类别用 to 的） */
export function mergeRegionInto(from: number, to: number) {
  if (!from || !to || from === to) return;
  const name = currentName();
  const mask = maskMap.get(name);
  const map = getDecodedFor(name);
  if (!name || !mask || !map) return;
  const fromRegion = mask.regions.find(r => r.ordinal === from);
  const toRegion = mask.regions.find(r => r.ordinal === to);
  if (!fromRegion || !toRegion) return;

  checkpoint(name);
  for (let i = 0; i < map.length; i++) if (map[i] === from) map[i] = to;
  const regions = mask.regions
    .filter(r => r.ordinal !== from)
    .map(r => ({ ...r, ordinal: r.ordinal > from ? r.ordinal - 1 : r.ordinal }));
  for (let i = 0; i < map.length; i++) {
    const v = map[i];
    if (v && v > from) map[i] = v - 1;
  }
  const newTo = to > from ? to - 1 : to;
  // 严格重叠：被遮挡像素也要跟着并过来，否则合并后实例会「丢形状」
  const mergedOccluded = unionIndexRuns(toRegion.occluded, fromRegion.occluded);
  const mergedRegions = mergedOccluded
    ? regions.map(r => r.ordinal === newTo ? { ...r, occluded: mergedOccluded } : r)
    : regions;
  storeMask(name, { width: mask.width, height: mask.height, counts: [], ids: [], regions: mergedRegions }, map);
  ui.segSelectedRegion = newTo;
  finalizeMaskEdit(name);
  bump();
  showToast('已合并两个区域（Ctrl+Z 可撤销）', 'success');
}


// ============================================================
// 本地缓存（复用三种模式共用的保存链路）
// ============================================================
// 为什么不再坚持「掩膜只进工程文件」：
// 那样在分割模式下**永远显示「未保存」**，保存按钮/Ctrl+S 也没有任何效果 ——
// 用户看到的就是「这个模式不保存」。改成：和标注一样，改动后 500 ms 自动写进
// localStorage（独立 key，不污染 annotator_data），状态栏语义与另外两个模式完全一致。
// 工程文件仍然是权威落盘方式；本地缓存只是防崩溃/方便接着改。

function persistMasksToStorage(): { ok: boolean; message?: string } {
  if (!storageDirty) return { ok: true };   // 没改动就不重写（避免检测模式下每次保存都重写几 MB）
  const json = JSON.stringify(serializeMasks());
  if (json.length > MASK_LS_BUDGET) {
    return {
      ok: false,
      message:
        `分割掩膜约 ${(json.length / 1048576).toFixed(1)} MB，超过本地缓存上限 ` +
        `${(MASK_LS_BUDGET / 1048576).toFixed(1)} MB —— 请用工具栏「保存工程」落盘（改动还在内存里，没丢）`,
    };
  }
  try {
    localStorage.setItem(MASK_STORAGE_KEY, json);
  } catch (e: any) {
    return {
      ok: false,
      message: `分割掩膜写入本地缓存失败（${e?.message || e}）—— 请用「保存工程」落盘`,
    };
  }
  storageDirty = false;
  ui.maskDirty = {};
  return { ok: true };
}

function restoreMasksFromStorage() {
  try {
    const raw = localStorage.getItem(MASK_STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return;
    loadMasksFromProject(obj);
    ui.maskDirty = {};
    storageDirty = false;
  } catch {
    // 坏数据忽略，不影响启动
  }
}

registerMaskPersistence(persistMasksToStorage, restoreMasksFromStorage);
