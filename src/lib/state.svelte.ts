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
  samMultiMask: false,
  samPcsPreview: null as { points: { x: number; y: number }[] } | null,
  theme: 'dark' as 'dark' | 'light',
  toastMessages: [] as { id: number; msg: string; type: 'info' | 'success' | 'error' }[],
  activeClass: 'person',
  workMode: 'detection' as 'detection' | 'classification',
  showModeSelect: true,
  imageLabels: {} as Record<string, string[]>,
  shortcuts: {
    select: 'v', rect: 'r', polygon: 'p', rotated: 'o', keypoint: 'k',
    sam: 'm',
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
  if (name) imageModified[name] = true;
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
  ui.history = ui.history.slice(0, ui.historyIndex + 1);
  ui.history.push({ imageName: name, annotations: snapshot });
  if (ui.history.length > maxHistory) ui.history.shift();
  ui.historyIndex = ui.history.length - 1;
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

export function saveAnnotations() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = { annotations, classes, classColors, theme: ui.theme, imageLabels: ui.imageLabels };
    try { localStorage.setItem('annotator_data', JSON.stringify(data)); } catch {}
    saveTimer = null;
    // 自动保存后清除未保存标记
    Object.keys(imageModified).forEach(k => delete imageModified[k]);
  }, 500);
}

// 立即保存（页面关闭前调用）
export function saveAnnotationsNow() {
  const data = { annotations, classes, classColors, theme: ui.theme, imageLabels: ui.imageLabels };
  try { localStorage.setItem('annotator_data', JSON.stringify(data)); } catch {}
  // 清除未保存标记
  Object.keys(imageModified).forEach(k => delete imageModified[k]);
}

export function loadSavedData() {
  try {
    const data = JSON.parse(localStorage.getItem('annotator_data') || '{}');
    if (data.annotations) Object.assign(annotations, data.annotations);
    if (data.classes) { classes.length = 0; classes.push(...data.classes); }
    if (data.classColors) Object.assign(classColors, data.classColors);
    if (data.theme) ui.theme = data.theme;
    if (data.imageLabels) ui.imageLabels = data.imageLabels;
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
    anns.forEach(a => { counts[a.className] = (counts[a.className] || 0) + 1; });
  }
  return counts;
});

export function getImagesWithAnnotations() { return _imagesWithAnnotations; }
export function getTotalAnnotationCount() { return _totalAnnotationCount; }
export function getCurrentAnnotations() { return _currentAnnotations; }
export function getClassCounts() { return _classCounts; }


