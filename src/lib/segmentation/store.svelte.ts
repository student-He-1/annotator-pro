/** 分割模式的存储层：索引图 / 事务编码 / 候选 / 独立撤销栈 / overlay 缓存。
 *
 *  铁律 B（方案 §1）：分割模式的所有新状态都走独立命名空间 ——
 *  数据存在本文件的 `maskMap` 里（**不进 $state**，2 MB 级数组不能被深代理包住），
 *  UI 状态走 `ui.mask* / ui.seg*`，和 `annotations` 零交叉：
 *  分割模式下 `annotations[name]` 恒为空，所以检测/分类的渲染、导出、统计、
 *  撤销逻辑天然碰不到掩膜数据。
 */
import { ui, images, showToast } from '../state.svelte';
import { normalizePrompt } from '../sam';
import { DEFAULT_SEG_COLORS, SEG_ZH_TO_EN, colorForNewSegClass, inferKind } from './presets';
import {
  encodeRuns, decodeRuns, regionStats, removeOrdinalInPlace, parseRunString, runStringOf,
} from './rle';
import { buildOverlayCanvas } from './overlay';
import { pcsWithMask, predictWithMask, clearSegSamCache, connectSegBackend, isSegMaskSupported, isSegServerReady } from './samMask';
import type { ImageMask, MaskCandidate, MaskRegion, MaskRegionKind, ProjectMask, SegmentationSettings } from './types';

const MAX_MASK_HISTORY = 30;
const MAX_DECODED = 2;

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
// 独立撤销栈（绝不和检测模式的 ui.history 混用，方案 §10.4）
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

function storeMask(name: string, mask: ImageMask, map: Uint8Array | null) {
  const enc = map ? encodeRuns(map) : { counts: [...mask.counts], ids: [...mask.ids] };
  maskMap.set(name, { ...mask, counts: enc.counts, ids: enc.ids });
  if (map) cacheDecoded(name, map);
  else decodeCache.delete(name);
  if (map) ui.maskDirty[name] = true;
  refreshMeta();
  bump();
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

/** 点提示 → 一个候选 */
export async function runPointPrompt(x: number, y: number, label: 0 | 1 = 1): Promise<void> {
  const img = ui.currentImage;
  const name = currentName();
  if (!name || !img) { showToast('请先选择一张图片', 'error'); return; }
  ui.segPromptRunning = true;
  try {
    if (!isSegServerReady() || !isSegMaskSupported()) {
      const st = await connectSegBackend(true);
      ui.segBackendReady = st.ready;
      ui.segMaskSupported = st.maskSupported;
      if (!st.ready) { showToast(st.error || '后端未就绪', 'error'); return; }
    }
    const res = await predictWithMask(img, Math.round(x), Math.round(y), label);
    if (!res.map) {
      showToast('后端没有返回掩膜（旧后端），点提示暂时不可用', 'error');
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
    showToast(`点分割：${className}，${area} px（score ${res.score.toFixed(3)}）`, area > 0 ? 'success' : 'error');
  } catch (e: any) {
    showToast('点分割失败：' + (e?.message || e), 'error');
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

  const img = images[ui.currentImageIndex];
  const w = candW || img?.width || 0;
  const h = candH || img?.height || 0;
  if (!w || !h) return;

  let mask = maskMap.get(name);
  if (mask && (mask.width !== w || mask.height !== h)) {
    showToast(`这张图已有 ${mask.width}x${mask.height} 的掩膜，与当前图尺寸不一致，已跳过`, 'error');
    return;
  }
  if (!mask) mask = emptyMask(w, h);
  if (mask.regions.length + ks.length > 255) {
    showToast('单图最多 255 个区域（索引图是 8 位）；请先删掉一些区域', 'error');
    return;
  }

  checkpoint(name);
  const map = getDecodedFor(name) || new Uint8Array(w * h);

  // k(候选值) → 正式 ordinal
  const kToOrdinal = new Uint16Array(256);
  const newRegions: ImageMask['regions'] = [];
  for (const k of ks) {
    const cand = candidates.find(c => c.k === k);
    if (!cand) continue;
    const ordinal = mask.regions.length + newRegions.length + 1;
    kToOrdinal[k] = ordinal;
    newRegions.push({
      ordinal,
      className: ensureSegClass(className || cand.className),
      kind: kind || cand.kind,
      score: cand.score,
      source: 'pcs',
      box: cand.box,
      area: cand.area,
    });
  }
  if (newRegions.length === 0) return;

  // 一遍铺完所有接受的候选
  for (let i = 0; i < candMap.length; i++) {
    const v = candMap[i];
    if (v && kToOrdinal[v]) map[i] = kToOrdinal[v];
  }

  const regions = [...mask.regions, ...newRegions];
  // 用铺完的图重算 area/box（候选的 box 来自后端，可能与像素实际范围有 1~2 px 差）
  for (const r of newRegions) {
    const st = regionStats(map, w, r.ordinal);
    r.area = st.area;
    if (st.box) r.box = st.box;
  }

  storeMask(name, { width: w, height: h, counts: [], ids: [], regions }, map);

  for (const k of ks) discardCandidateSilent(k);
  discardCandidateSilentCleanup();
  bump();
  showToast(`已接受 ${newRegions.length} 个区域（共 ${regions.length} 个）`, 'success');
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
  refreshMeta();
  bump();
}

export function clearImageMask() {
  const name = currentName();
  if (!maskMap.has(name)) return;
  checkpoint(name);
  maskMap.delete(name);
  decodeCache.delete(name);
  ui.maskDirty[name] = true;
  ui.segSelectedRegion = 0;
  refreshMeta();
  bump();
}

// ============================================================
// 命中测试 / 选中
// ============================================================
export function selectRegion(ordinal: number) {
  ui.segSelectedRegion = ordinal;
  bump();
}

export function clearRegionSelection() {
  if (!ui.segSelectedRegion) return;
  ui.segSelectedRegion = 0;
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
  else if (!st.maskSupported) showToast('后端在线，但版本太旧：没有 mask 能力（方案 §5 的 return_mask / features）', 'error');
  else showToast('SAM3 后端已就绪（支持像素级掩膜）', 'success');
}

export function onImageSwitched() {
  clearCandidates();
  clearSegSamCache();
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
  };
}

export function loadSegSettings(s: SegmentationSettings | undefined) {
  if (!s) return;
  if (s.overlayMode === 'instance' || s.overlayMode === 'class') ui.segOverlayMode = s.overlayMode;
  if (typeof s.overlayOpacity === 'number') ui.segOverlayOpacity = s.overlayOpacity;
  if (Array.isArray(s.classes) && s.classes.length > 0) ui.segClasses = [...s.classes];
  if (s.classColors) ui.segClassColors = { ...ui.segClassColors, ...s.classColors };
}

export function markMasksSaved() {
  ui.maskDirty = {};
}

export function getMaskDirty(name: string): boolean {
  return !!ui.maskDirty[name];
}

/** 删图片时把它的掩膜也删掉（否则以后重新导入同名图片会「继承」上一次的掩膜）。 */
export function deleteImageMask(name: string) {
  if (!name) return;
  maskMap.delete(name);
  decodeCache.delete(name);
  delete ui.maskDirty[name];
  refreshMeta();
  bump();
}

/** 有掩膜的图片（批量导出用；getExportData 在 annotations 为空时返回 null，不能复用） */
export function getImagesWithMasks(): { name: string; width: number; height: number }[] {
  ui.maskRev;
  const out: { name: string; width: number; height: number }[] = [];
  for (const [name, mask] of maskMap) {
    if (mask.regions.length > 0) out.push({ name, width: mask.width, height: mask.height });
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
