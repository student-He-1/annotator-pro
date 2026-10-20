/** 全局状态管理 — Svelte 5 runes */
import type { Annotation, AnnotationType, ToolType, ImageInfo, ShortcutMap, ExportFormat, DragHandle, HistoryEntry, Point } from './types';

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
  workMode: 'detection' as 'detection' | 'classification',
  showModeSelect: true,
  imageLabels: {} as Record<string, string[]>,
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

// 批量改类别：scope='all' 所有图片，'current' 当前图片
export function batchChangeClass(oldClass: string, newClass: string, scope: 'all' | 'current' = 'all'): number {
  let count = 0;
  const targetImages = scope === 'all' ? images : (ui.currentImageIndex >= 0 ? [images[ui.currentImageIndex]] : []);
  for (const img of targetImages) {
    const anns = annotations[img.name];
    if (!anns) continue;
    for (const ann of anns) {
      if (ann.className === oldClass) {
        ann.className = newClass;
        count++;
      }
    }
  }
  if (count > 0) {
    markModified();
    saveAnnotations();
  }
  return count;
}

// 批量删除某类别：scope='all' 所有图片，'current' 当前图片
export function batchDeleteClass(className: string, scope: 'all' | 'current' = 'all'): number {
  let count = 0;
  const targetImages = scope === 'all' ? images : (ui.currentImageIndex >= 0 ? [images[ui.currentImageIndex]] : []);
  for (const img of targetImages) {
    const anns = annotations[img.name];
    if (!anns) continue;
    const before = anns.length;
    annotations[img.name] = anns.filter(a => a.className !== className);
    count += before - annotations[img.name].length;
    if (ui.selectedAnnotation && ui.selectedAnnotation.className === className) {
      ui.selectedAnnotation = null;
    }
  }
  if (count > 0) {
    markModified();
    saveAnnotations();
  }
  return count;
}

// 批量删除所有标注：scope='all' 所有图片，'current' 当前图片
export function batchDeleteAll(scope: 'all' | 'current' = 'all'): number {
  let count = 0;
  const targetImages = scope === 'all' ? images : (ui.currentImageIndex >= 0 ? [images[ui.currentImageIndex]] : []);
  for (const img of targetImages) {
    const anns = annotations[img.name];
    if (anns) count += anns.length;
    annotations[img.name] = [];
  }
  ui.selectedAnnotation = null;
  if (count > 0) {
    markModified();
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
  for (let i = ui.currentImageIndex + 1; i < images.length; i++) {
    const dstName = images[i].name;
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
    imageModified[dstName] = true;
  }
  if (totalCopied > 0) {
    markModified();
    saveAnnotations();
  }
  return totalCopied;
}

export function pushHistory() {
  if (ui.currentImageIndex < 0) return;
  const name = images[ui.currentImageIndex]?.name;
  if (!name) return;
  const snapshot = JSON.parse(JSON.stringify(annotations[name] || []));
  // 分类模式下图上的「标注」永远是空的，唯一会变的是 ui.imageLabels。
  // 所以快照必须把标签也带上，否则「打标签」这条历史会被下面的去重逻辑
  // 判成「和上一条一模一样」直接丢掉，Ctrl+Z 就成了空操作。
  const labels = [...(ui.imageLabels[name] || [])];

  // 去重：状态没变就不产生历史点。
  // 否则「鼠标点一下选中标注」「按下手柄但没拖动」都会 push 一条与上一条完全相同的快照，
  // 用户按 Ctrl+Z 看起来就像没反应（得连按好几次才真正退一格）。
  const last = ui.history[ui.historyIndex];
  if (last && last.imageName === name
      && JSON.stringify(last.annotations) === JSON.stringify(snapshot)
      && JSON.stringify(last.labels || []) === JSON.stringify(labels)) {
    return;
  }

  ui.history = ui.history.slice(0, ui.historyIndex + 1);
  ui.history.push({ imageName: name, annotations: snapshot, labels });
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
// 按模式取数（分类 / 检测两套统计口径的唯一入口）
// ============================================================
// 分类模式的数据在 ui.imageLabels 上，检测模式的数据在 annotations 上。
// 谁要在界面上显示「多少个」，都必须走这两个函数，别再直接调
// getTotalAnnotationCount() —— 那会让分类模式永远显示 0。
export function getCurrentModeCount(): number {
  return ui.workMode === 'classification' ? _totalLabelCount : _totalAnnotationCount;
}

/** 数量后面的量词 */
export function getCurrentModeUnit(): string {
  return ui.workMode === 'classification' ? '个标签' : '处标注';
}

/** 分类模式下「打过标签的图片张数」 */
export function getLabeledImageCount(): number {
  return images.filter(img => (ui.imageLabels[img.name] || []).length > 0).length;
}


