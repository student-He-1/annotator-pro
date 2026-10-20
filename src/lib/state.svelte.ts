/** 全局状态管理 — Svelte 5 runes */
import type { Annotation, AnnotationType, ToolType, ImageInfo, ShortcutMap, ExportFormat, DragHandle, HistoryEntry, ImageSnapshot, Point } from './types';
import { DEFAULT_SEG_CLASSES, DEFAULT_SEG_COLORS } from './segmentation/presets';
import type { SegSweepResult } from './segmentation/types';

// ============================================================
// Reactive State — object/array types (exported directly, only properties mutated)
// ============================================================

export let images = $state<ImageInfo[]>([]);
export let annotations: Record<string, Annotation[]> = $state({});
export let classes = $state<string[]>(['person', 'car', 'dog', 'cat', 'bicycle']);
export let classColors: Record<string, string> = $state({
  person: '#58a6ff', car: '#3fb950', dog: '#d2991d', cat: '#f85149', bicycle: '#a371f7',
});
export let imageModified: Record<string, boolean> = $state({});

// ============================================================
// UI State — primitive types wrapped in object (Svelte 5 rule: reassignable $state cannot be exported directly)
// ============================================================

export const ui = $state({
  currentImageIndex: -1,
  currentImage: null as HTMLImageElement | null,
  /** 正在加载新图片：此时底图可能还是上一张，render() 会跳过标注绘制，避免错配残影 */
  imageLoading: false,
  currentTool: 'select' as ToolType,
  selectedAnnotation: null as Annotation | null,
  zoom: 1,
  panX: 0,
  panY: 0,
  isDrawing: false,
  drawingAnnotation: null as Annotation | null,
  polygonPoints: [] as (Point & { className?: string })[],
  dragHandle: null as DragHandle | null,
  dragStart: null as Point | null,
  draggingVertex: -1,
  history: [] as HistoryEntry[],
  historyIndex: -1,
  recordingShortcut: null as string | null,
  exportFormat: 'voc' as ExportFormat,
  skeletonId: 'none',
  nextTrackId: 1,
  magicWandTolerance: 32,
  magicWandContiguous: true,
  magicWandSimplify: 3,
  samMaskThreshold: 0.0,
  samSimplifyTolerance: 1.0,
  /** 与 sam.ts 的 DEFAULT_SAM_CONFIG 保持一致。
   *  原来这里是 false，而弹窗用的是 DEFAULT_SAM_CONFIG.multiMask = true ——
   *  同一个开关在两个入口默认值不同，就是「两套参数」问题的另一面。 */
  samMultiMask: true,
  samPcsPreview: null as { points: { x: number; y: number }[] } | null,
  theme: 'dark' as 'dark' | 'light',
  toastMessages: [] as { id: number; msg: string; type: 'info' | 'success' | 'error' }[],
  /** 导入图片期间的加载进度。
   *  原来 App.svelte 的进度条模板直接读这四个字段，但 store 里根本没有它们 →
   *  `ui.isLoading` 永远是 undefined，进度条是一块永远不显示的「死 UI」。 */
  isLoading: false,
  loadingCurrent: 0,
  loadingTotal: 0,
  loadingProgress: 0,
  /** 鼠标在画布上的图像坐标（不是屏幕坐标）。状态栏读这两个值。
   *  以前 StatusBar 的 updateMousePos() 从没被调用过，所以坐标恒为 0,0。 */
  mouseImgX: 0,
  mouseImgY: 0,
  mouseOverCanvas: false,
  /** 模型/后端的「已就绪」状态必须放在 $state 里。
   *  原来 yolo.ts / sam.ts 各自用一个模块级普通变量存着，组件的
   *  `$derived(isModelLoaded())` 读不到变化 → 加载成功那一刻界面不刷新，
   *  非得关掉弹窗重开（重新创建组件）才看得到「已加载」。 */
  samModelReady: false,
  yoloModelName: '',
  yoloClassCount: 0,
  activeClass: 'person',
  workMode: 'detection' as 'detection' | 'classification' | 'segmentation',
  showModeSelect: true,
  imageLabels: {} as Record<string, string[]>,
  // ============================================================
  // 图像分割模式（第三个模式）的独立状态命名空间
  // 铁律 B：只新增 ui.mask* / ui.seg* 前缀字段，绝不往上面的检测/分类字段里塞东西。
  // 这些字段不读它的旧代码完全不受影响（方案 §1 允许的改动类型 ①）。
  // ============================================================
  /** 掩膜数据版本号：掩膜本体存在 segmentation/store.svelte.ts 里（不进 $state），
   *  组件要响应式刷新就靠读它 */
  maskRev: 0,
  /** 每张图的区域数（Sidebar 徽标 / 状态栏 / 统计用） */
  maskCounts: {} as Record<string, number>,
  maskTotal: 0,
  /** 掩膜脏标记：掩膜只随工程文件保存，不进 localStorage（5 MB 装不下），
   *  所以不能复用 imageModified —— 那会让状态栏把「没写盘」显示成「已保存」 */
  maskDirty: {} as Record<string, boolean>,
  /** 当前选中的区域 ordinal（0 = 没选） */
  segSelectedRegion: 0,
  segOverlayMode: 'instance' as 'instance' | 'class',
  segOverlayOpacity: 0.45,
  segShowOverlay: true,
  segShowCandidate: true,
  segConfThreshold: 0.3,
  segBackendReady: false,
  segMaskSupported: false,
  segPromptRunning: false,
  segText: '',
  /** 点提示工具用的类别（文本提示的类别由输入框决定） */
  segActiveClass: 'road',
  /** 分割模式的导出格式单独一个字段：ui.exportFormat 是检测/分类共用的，
   *  往里塞 seg_* 会让切回检测模式时格式下拉框显示空白（值不在选项里） */
  segExportFormat: 'seg_coco' as string,
  /** 分割模式自己的类别表 —— 不写进检测/分类在用的 classes，避免污染它们的导出与统计 */
  segClasses: [...DEFAULT_SEG_CLASSES],
  segClassColors: { ...DEFAULT_SEG_COLORS },
  /** 类别名 → Cityscapes trainId 的**手动覆盖**（预置 19 类已内置映射，这里只放用户自定义的开放词汇）。
   *  未映射的类别在导出语义图时写 255(void)。 */
  segCityscapesMap: {} as Record<string, number>,
  // ---- 一键全类扫描（P1c-1）----
  /** 要扫的类别（从 segClasses 里勾选） */
  segSweepClasses: [...DEFAULT_SEG_CLASSES],
  /** 自动接受阈值：score ≥ 它的直接进正式掩膜；中间的留给用户复核 */
  segSweepAutoAccept: 0.7,
  segSweepRunning: false,
  segSweepCancel: false,
  segSweepDone: 0,
  segSweepTotal: 0,
  segSweepCurrent: '',
  segSweepResults: [] as SegSweepResult[],
  shortcuts: {
    select: 'v', rect: 'r', polygon: 'p', rotated: 'o', keypoint: 'k',
    sam: 'm', magicwand: 'w',
    undo: 'ctrl+z', redo: 'ctrl+y', redoAlt: 'ctrl+shift+z',
    delete: 'delete', copy: 'ctrl+d',
    zoomIn: 'ctrl+=', zoomOut: 'ctrl+-', fit: 'ctrl+0',
    save: 'ctrl+s',
  } as ShortcutMap,
});

export const maxHistory = 30;
let toastId = 0;

// ============================================================
// Constants
// ============================================================
export const COLORS = ['#58a6ff', '#3fb950', '#d2991d', '#f85149', '#a371f7', '#39d2c0', '#db6dab', '#8b949e'];

// ============================================================
// Helpers
// ============================================================
export function getClassColor(className: string): string {
  return classColors[className] || '#8b949e';
}

export function getActiveClass(): string {
  return ui.activeClass || classes[0] || 'object';
}

export function setActiveClass(className: string) {
  ui.activeClass = className;
}

export function getNextAnnotationId(): number {
  if (ui.currentImageIndex < 0 || !images[ui.currentImageIndex]) return 0;
  const anns = annotations[images[ui.currentImageIndex].name] || [];
  return anns.length > 0 ? Math.max(...anns.map(a => a.id)) + 1 : 0;
}

export function addAnnotation(ann: Annotation) {
  if (ui.currentImageIndex < 0) return;
  const name = images[ui.currentImageIndex].name;
  if (!annotations[name]) annotations[name] = [];
  annotations[name].push(ann);
  markModified();
}

export function deleteAnnotation(ann: Annotation) {
  if (ui.currentImageIndex < 0) return;
  const name = images[ui.currentImageIndex].name;
  if (!annotations[name]) return;
  const idx = annotations[name].findIndex(a => a.id === ann.id);
  if (idx >= 0) {
    annotations[name].splice(idx, 1);
    if (ui.selectedAnnotation && ui.selectedAnnotation.id === ann.id) ui.selectedAnnotation = null;
    markModified();
  }
}

export function selectAnnotation(ann: Annotation | null) {
  ui.selectedAnnotation = ann;
}

export function setTool(tool: ToolType) {
  ui.currentTool = tool;
  ui.polygonPoints = [];
  ui.selectedAnnotation = null;
}

export function markModified() {
  if (ui.currentImageIndex < 0) return;
  const name = images[ui.currentImageIndex]?.name;
  if (!name) return;
  imageModified[name] = true;
  // 改动后自动安排一次保存（500ms 防抖）。
  //
  // 以前这里只置标志位、不安排保存：只有切图 / 导出 / Ctrl+S 这些动作才会调
  // saveAnnotations()，而清标志位又是在保存成功的回调里做的。
  // 结果就是「一直在这张图上画」时，状态栏永远显示「未保存」——数据其实还没落盘，
  // 指示器没撒谎，但和「自动保存」的用户预期不符。现在改成改完就排队保存，
  // 停手 500ms 后写盘成功 → 标志位清掉 → 自动变「已保存」。
  saveAnnotations();
}

export function isModified(): boolean {
  if (ui.currentImageIndex < 0) return false;
  const name = images[ui.currentImageIndex]?.name;
  return name ? !!imageModified[name] : false;
}

export function clearModified() {
  if (ui.currentImageIndex < 0) return;
  const name = images[ui.currentImageIndex]?.name;
  if (name) imageModified[name] = false;
}

// ============================================================
// Annotation Tracking (copy to next frame)
// ============================================================
export function copyAllToNextImage(): number {
  if (ui.currentImageIndex < 0 || ui.currentImageIndex >= images.length - 1) return 0;
  const srcName = images[ui.currentImageIndex].name;
  const dstName = images[ui.currentImageIndex + 1].name;
  const srcAnns = annotations[srcName] || [];
  if (srcAnns.length === 0) return 0;

  if (!annotations[dstName]) annotations[dstName] = [];
  const maxId = annotations[dstName].length > 0
    ? Math.max(...annotations[dstName].map(a => a.id)) : -1;

  let newId = maxId + 1;
  let copied = 0;
  srcAnns.forEach(ann => {
    const copy = JSON.parse(JSON.stringify(ann));
    copy.id = newId++;
    if (copy.trackId === undefined) copy.trackId = ann.id;
    annotations[dstName].push(copy);
    copied++;
  });

  imageModified[dstName] = true;
  return copied;
}

export function copySelectedToNextImage(): boolean {
  if (ui.currentImageIndex < 0 || ui.currentImageIndex >= images.length - 1) return false;
  if (!ui.selectedAnnotation) return false;
  const dstName = images[ui.currentImageIndex + 1].name;
  if (!annotations[dstName]) annotations[dstName] = [];

  const maxId = annotations[dstName].length > 0
    ? Math.max(...annotations[dstName].map(a => a.id)) : -1;

  const copy = JSON.parse(JSON.stringify(ui.selectedAnnotation));
  copy.id = maxId + 1;
  if (copy.trackId === undefined) copy.trackId = ui.selectedAnnotation.id;
  annotations[dstName].push(copy);
  imageModified[dstName] = true;
  return true;
}

// ============================================================
// Batch Operations
// ============================================================

/** 批量操作的作用范围：全部图片 / 当前图片 / 指定图片区间（第 start~end 张，1 起、闭区间）。 */
export type BatchScope = 'all' | 'current' | 'range';

/** 把 scope 解析成实际的图片列表。range 的 start/end 是界面上的 1 起序号。 */
export function batchTargets(scope: BatchScope, rangeStart = 1, rangeEnd = 0): ImageInfo[] {
  if (scope === 'current') return ui.currentImageIndex >= 0 ? [images[ui.currentImageIndex]] : [];
  if (scope === 'range') {
    const s = Math.max(0, rangeStart - 1);
    const e = Math.min(images.length, rangeEnd > 0 ? rangeEnd : images.length);
    return s < e ? images.slice(s, e) : [];
  }
  return images;
}

// 批量改类别：scope='all' 所有图片，'current' 当前图片，'range' 指定区间
export function batchChangeClass(oldClass: string, newClass: string, scope: BatchScope = 'all', rangeStart = 1, rangeEnd = 0): number {
  let count = 0;
  const targetImages = batchTargets(scope, rangeStart, rangeEnd);
  // 批量会一次改多张图：改动**前**先给每张图记下本轮初始状态。
  // 否则那些「还没打开过」的图没有基线，撤销到底会被还原成空白（原始标注丢失）。
  for (const img of targetImages) captureUndoBaseline(img.name);
  const changed: string[] = [];
  for (const img of targetImages) {
    const anns = annotations[img.name];
    if (!anns) continue;
    let hit = 0;
    for (const ann of anns) {
      if (ann.className === oldClass) {
        ann.className = newClass;
        count++;
        hit++;
      }
    }
    if (hit > 0) { changed.push(img.name); imageModified[img.name] = true; }
  }
  if (count > 0) {
    // 一次操作涉及的所有图，整体进一条历史，Ctrl+Z 才能整体还原。
    pushHistory(changed);
    saveAnnotations();
  }
  return count;
}

// 批量删除某类别：scope='all' 所有图片，'current' 当前图片，'range' 指定区间
export function batchDeleteClass(className: string, scope: BatchScope = 'all', rangeStart = 1, rangeEnd = 0): number {
  let count = 0;
  const targetImages = batchTargets(scope, rangeStart, rangeEnd);
  for (const img of targetImages) captureUndoBaseline(img.name);
  const changed: string[] = [];
  for (const img of targetImages) {
    const anns = annotations[img.name];
    if (!anns) continue;
    const before = anns.length;
    annotations[img.name] = anns.filter(a => a.className !== className);
    const removed = before - annotations[img.name].length;
    if (removed > 0) { count += removed; changed.push(img.name); imageModified[img.name] = true; }
    if (ui.selectedAnnotation && ui.selectedAnnotation.className === className) {
      ui.selectedAnnotation = null;
    }
  }
  if (count > 0) {
    pushHistory(changed);
    saveAnnotations();
  }
  return count;
}

// 批量删除所有标注：scope='all' 所有图片，'current' 当前图片，'range' 指定区间
export function batchDeleteAll(scope: BatchScope = 'all', rangeStart = 1, rangeEnd = 0): number {
  let count = 0;
  const targetImages = batchTargets(scope, rangeStart, rangeEnd);
  for (const img of targetImages) captureUndoBaseline(img.name);
  const changed: string[] = [];
  for (const img of targetImages) {
    const anns = annotations[img.name];
    const had = anns ? anns.length : 0;
    if (had > 0) { count += had; changed.push(img.name); imageModified[img.name] = true; }
    annotations[img.name] = [];
  }
  ui.selectedAnnotation = null;
  if (count > 0) {
    pushHistory(changed);
    saveAnnotations();
  }
  return count;
}

// 复制当前图片标注到所有后续图片
export function copyToAllSubsequent(): number {
  const srcName = images[ui.currentImageIndex].name;
  const srcAnns = annotations[srcName] || [];
  if (srcAnns.length === 0) return 0;

  let totalCopied = 0;
  const changed: string[] = [];
  for (let i = ui.currentImageIndex + 1; i < images.length; i++) {
    const dstName = images[i].name;
    captureUndoBaseline(dstName);   // 目标图可能在批量前从未打开过，先补基线
    if (!annotations[dstName]) annotations[dstName] = [];
    const maxId = annotations[dstName].length > 0
      ? Math.max(...annotations[dstName].map(a => a.id)) : -1;
    let newId = maxId + 1;
    for (const ann of srcAnns) {
      const copy = JSON.parse(JSON.stringify(ann));
      copy.id = newId++;
      if (copy.trackId === undefined) copy.trackId = ann.id;
      annotations[dstName].push(copy);
      totalCopied++;
    }
    changed.push(dstName);
    imageModified[dstName] = true;
  }
  if (totalCopied > 0) {
    pushHistory(changed);
    saveAnnotations();
  }
  return totalCopied;
}

/** 构造某张图的「当前状态」快照（annotations + 分类标签）。
 *  分类模式下图上的 annotations 永远是空的，唯一会变的是 ui.imageLabels，
 *  所以快照必须把标签也带上，否则「打标签」这条历史会被去重逻辑判成空操作。 */
function snapshotImage(name: string): ImageSnapshot {
  return {
    imageName: name,
    annotations: JSON.parse(JSON.stringify(annotations[name] || [])),
    labels: [...(ui.imageLabels[name] || [])],
  };
}

/** 记一条历史（存的是「操作之后」的快照）。
 *
 *  - `names` 缺省 = 只记当前图（单图操作的老行为，全站数百处 `pushHistory()` 不用改）；
 *  - 传 `names` = 记这一批图（批量操作：一次改了 N 张，整体进一条，undo/redo 才能整体还原）。
 *
 *  去重：状态没变就不产生历史点 —— 否则「点一下选中标注」「按手柄没拖动」都会 push
 *  一条与上一条相同的快照，用户按 Ctrl+Z 像没反应（得连按几次才真正退一格）。
 */
export function pushHistory(names?: string[]) {
  let targetNames = names;
  if (!targetNames) {
    if (ui.currentImageIndex < 0) return;
    const name = images[ui.currentImageIndex]?.name;
    if (!name) return;
    targetNames = [name];
  }
  if (targetNames.length === 0) return;
  const changes = targetNames.map(snapshotImage);

  const last = ui.history[ui.historyIndex];
  if (last && JSON.stringify(last.changes) === JSON.stringify(changes)) {
    return;
  }

  ui.history = ui.history.slice(0, ui.historyIndex + 1);
  ui.history.push({ changes });
  if (ui.history.length > maxHistory) ui.history.shift();
  ui.historyIndex = ui.history.length - 1;
}

// ============================================================
// Undo 基线
// ============================================================
/**
 * 每张图「本轮一开始」的状态快照（JSON：`{ annotations, labels }`）。
 *
 * 历史条目记的是「操作之后的快照」，所以撤到最底那一步时，需要知道
 * 这张图在本轮第一次被改动**之前**是什么状态。
 * 以前这里偷懒直接写成 `[]`（当成「从空白开始画」），
 * 于是「打开工程 → 删掉几个标注 → Ctrl+Z」会把剩下的一起清空。
 */
const historyBaseline: Record<string, string> = {};

/** 记录某张图的初始状态（只记第一次）。图片加载完成时由 Canvas 调用。 */
export function captureUndoBaseline(name: string) {
  if (!name || historyBaseline[name] !== undefined) return;
  historyBaseline[name] = JSON.stringify({
    annotations: annotations[name] || [],
    labels: ui.imageLabels[name] || [],
  });
}

/** 图片被删掉 / 列表被清空时丢掉它的初始快照，
 *  否则以后重新导入同名图片，撤销到底会还原成上一轮的旧数据。 */
export function forgetUndoBaseline(name?: string) {
  if (name) { delete historyBaseline[name]; return; }
  for (const k of Object.keys(historyBaseline)) delete historyBaseline[k];
}

/** 撤销到底时要还原成的状态（没有基线就按空白算）。 */
export function getUndoBaseline(name: string): { annotations: Annotation[]; labels: string[] } {
  try {
    const raw = JSON.parse(historyBaseline[name] ?? 'null');
    if (raw && Array.isArray(raw.annotations)) {
      return { annotations: raw.annotations, labels: Array.isArray(raw.labels) ? raw.labels : [] };
    }
  } catch { /* 坏数据当成空白 */ }
  return { annotations: [], labels: [] };
}

/** 把一份快照写回某张图（撤销 / 重做共用）。
 *  分类标签为空时直接把 key 删掉，免得检测模式的图片在 imageLabels 里堆一堆空数组。 */
export function applySnapshot(name: string, snap: { annotations: Annotation[]; labels?: string[] }) {
  annotations[name] = JSON.parse(JSON.stringify(snap.annotations || []));
  const labels = snap.labels || [];
  if (labels.length > 0) ui.imageLabels[name] = [...labels];
  else delete ui.imageLabels[name];
}

export function canUndo(): boolean {
  return ui.historyIndex >= 0;
}

export function canRedo(): boolean {
  return ui.historyIndex < ui.history.length - 1;
}

// ============================================================
// Toast
// ============================================================
export function showToast(msg: string, type: 'info' | 'success' | 'error' = 'info') {
  const id = ++toastId;
  ui.toastMessages.push({ id, msg, type });
  setTimeout(() => {
    ui.toastMessages = ui.toastMessages.filter(t => t.id !== id);
  }, 2500);
}

// ============================================================
// Persistence（防抖，避免频繁写 localStorage 阻塞 UI）
// ============================================================
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 防抖保存（500ms 内的连续改动合成一次写盘）。`markModified()` 会自动调用它。 */
export function saveAnnotations() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveAnnotationsNow();
  }, 500);
}

/** 立刻保存。返回是否真的写成功。
 *
 *  - 工具栏「保存标注」按钮和 Ctrl+S 走这里，按下去状态栏马上变「已保存」；
 *  - 写 localStorage 失败（比如空间满）时**不**清「未保存」标志，并如实报错 ——
 *    以前这里 `catch {}` 吞掉异常、照样清标志，会变成「显示已保存但其实没存」。
 *  - 分割模式的掩膜由 store 注册进来的钩子一并落盘（见 `registerMaskPersistence`），
 *    这样三种模式共用**同一个**保存键 / 自动保存 / 状态栏语义。
 */
export function saveAnnotationsNow(): boolean {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const data = { annotations, classes, classColors, theme: ui.theme, imageLabels: ui.imageLabels, skeletonId: ui.skeletonId };
  try {
    localStorage.setItem('annotator_data', JSON.stringify(data));
  } catch (e: any) {
    showToast(`保存失败：本地存储写入被拒绝（${e?.message || e}）`, 'error');
    return false;
  }
  // 分割掩膜跟着一起保存（store 里注册，state 不 import 它 → 不会成环）
  if (saveMasksHook) {
    const r = saveMasksHook();
    if (!r.ok) {
      showToast(r.message || '分割掩膜保存失败', 'error');
      return false;   // 不清「未保存」：宁可显示未保存，也不要谎报已保存
    }
  }
  // 写盘成功才清「未保存」标记
  Object.keys(imageModified).forEach(k => delete imageModified[k]);
  return true;
}

export function loadSavedData() {
  try {
    const data = JSON.parse(localStorage.getItem('annotator_data') || '{}');
    if (data.annotations) Object.assign(annotations, data.annotations);
    if (data.classes) { classes.length = 0; classes.push(...data.classes); }
    if (data.classColors) Object.assign(classColors, data.classColors);
    if (data.theme) ui.theme = data.theme;
    if (data.imageLabels) ui.imageLabels = data.imageLabels;
    // 记住上次选的关键点骨架模板，否则重启后回到「无骨架」，手动打点又要重新选
    if (data.skeletonId) ui.skeletonId = data.skeletonId;
    // 不恢复图片列表（dataUrl 刷新后失效，留空壳反而导致重新导入逻辑混乱；标注和文件名对应关系已保留，重新导入同名文件夹后自动匹配）
  } catch {}
  // 分割掩膜也从本地缓存恢复（和 annotations 同一套「按文件名匹配」的语义）
  try { loadMasksHook?.(); } catch {}
}

// ============================================================
// 分割模式持久化钩子
// ============================================================
// state 不能直接 import segmentation/store（store 已经 import 这里了，会成环），
// 所以由 store 在模块加载时把自己的存/取函数注册进来。
type MaskSaveHook = () => { ok: boolean; message?: string };
let saveMasksHook: MaskSaveHook | null = null;
let loadMasksHook: (() => void) | null = null;

export function registerMaskPersistence(save: MaskSaveHook, load: () => void) {
  saveMasksHook = save;
  loadMasksHook = load;
}

// 主题切换
export function applyTheme() {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = ui.theme;
  }
}

export function toggleTheme() {
  ui.theme = ui.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  saveAnnotations();
}

// ============================================================
// Derived (internal $derived + exported getters, per Svelte 5 rule)
// ============================================================
const _imagesWithAnnotations = $derived(
  images.filter(img => {
    const anns = annotations[img.name];
    return anns && anns.length > 0;
  })
);

const _totalAnnotationCount = $derived(
  images.reduce((sum, img) => sum + (annotations[img.name]?.length || 0), 0)
);

const _currentAnnotations = $derived(
  ui.currentImageIndex >= 0 && images[ui.currentImageIndex]
    ? (annotations[images[ui.currentImageIndex].name] || [])
    : []
);

const _classCounts = $derived.by(() => {
  const counts: Record<string, number> = {};
  if (ui.currentImageIndex >= 0 && images[ui.currentImageIndex]) {
    const anns = annotations[images[ui.currentImageIndex].name] || [];
    anns.forEach(a => {
      // 关键点不算「某个类别的目标实例」，不进类别统计。
      // 以前一个 68 点人脸骨架会被算成 1 个 person，类别列表里凭空多出一个 person。
      if (a.type === 'keypoint') return;
      counts[a.className] = (counts[a.className] || 0) + 1;
    });
  }
  return counts;
});

/** 当前图片上有几个关键点标注（数骨架，不是数点） */
const _currentKeypointCount = $derived.by(() => {
  if (ui.currentImageIndex < 0 || !images[ui.currentImageIndex]) return 0;
  return (annotations[images[ui.currentImageIndex].name] || []).filter(a => a.type === 'keypoint').length;
});

/** 分类模式下整个工程打了多少「标签」（不是标注个数） */
const _totalLabelCount = $derived(
  images.reduce((sum, img) => sum + (ui.imageLabels[img.name]?.length || 0), 0)
);

export function getImagesWithAnnotations() { return _imagesWithAnnotations; }
export function getTotalAnnotationCount() { return _totalAnnotationCount; }
export function getTotalLabelCount() { return _totalLabelCount; }
export function getCurrentAnnotations() { return _currentAnnotations; }
export function getClassCounts() { return _classCounts; }
export function getKeypointCount() { return _currentKeypointCount; }

// ============================================================
// 按模式取数（分类 / 检测 / 分割三套统计口径的唯一入口）
// ============================================================
// 分类模式的数据在 ui.imageLabels 上，检测模式的数据在 annotations 上，
// 分割模式的数据在 segmentation/store 里（区域数由 store 同步到 ui.maskTotal）。
// 谁要在界面上显示「多少个」，都必须走这两个函数，别再直接调
// getTotalAnnotationCount() —— 那会让分类模式永远显示 0。
export function getCurrentModeCount(): number {
  if (ui.workMode === 'segmentation') { ui.maskRev; return ui.maskTotal || 0; }
  return ui.workMode === 'classification' ? _totalLabelCount : _totalAnnotationCount;
}

/** 数量后面的量词 */
export function getCurrentModeUnit(): string {
  if (ui.workMode === 'segmentation') return '个区域';
  return ui.workMode === 'classification' ? '个标签' : '处标注';
}

/** 分类模式下「打过标签的图片张数」 */
export function getLabeledImageCount(): number {
  return images.filter(img => (ui.imageLabels[img.name] || []).length > 0).length;
}


