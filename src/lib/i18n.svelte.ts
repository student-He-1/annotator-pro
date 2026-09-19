import type { Language } from './types';

const zh: Record<string, string> = {
  fileList: '文件列表', dropHint: '拖拽图片或文件夹到此处\n或点击选择文件',
  welcomeText: '拖拽图片到此处开始标注', welcomeHint: '支持 JPG、PNG、BMP、WebP',
  noFile: '无文件', noChanges: '未修改', properties: '属性',
  annotationInfo: '标注信息', classList: '类别列表', export: '导出',
  selectHint: '选择一个标注查看属性', addClassPlaceholder: '添加新类别...',
  selectTool: '选择/移动', rectTool: '矩形框', polygonTool: '多边形',
  rotatedTool: '旋转框', keypointTool: '关键点', magicWandTool: '魔术棒', samTool: 'SAM智能分割',
  saved: '已保存', unsaved: '未保存', empty: '无文件',
  exportSuccess: '导出成功', exportFailed: '导出失败',
  importSuccess: '导入成功', importFailed: '导入失败',
  autoSaved: '已自动保存', classAdded: '类别已添加',
  classExists: '类别已存在', annotationDeleted: '标注已删除',
  settings: '设置', shortcuts: '快捷键', language: '语言',
  save: '保存', cancel: '取消', reset: '重置',
  shortcutConflict: '快捷键冲突',
  undo: '撤销', redo: '重做', delete: '删除', copy: '复制',
  zoomIn: '放大', zoomOut: '缩小', fitScreen: '适应画面',
  noAnnotations: '没有标注可导出',
  recording: '按下快捷键...', pressKey: '请按下组合键',
  importFolder: '导入文件夹', addFiles: '添加图片',
  currentExport: '导出当前图片', batchExportBtn: '批量导出全部',
  chooseFormat: '选择格式', exporting: '正在导出...',
  exportComplete: '导出完成', exportedFiles: '已导出文件',
  noImagesToExport: '没有可导出的标注',
  totalImages: '张图片', totalAnnotations: '个标注',
  folderNotSupported: '浏览器不支持文件夹写入',
  id: '编号', type: '类型', label: '标签', coordinates: '坐标',
  annotated: '已标注',
  rectHint: '点击并拖拽创建矩形框',
  polygonHint: '点击创建多边形顶点，双击或按Enter完成',
  rotateBoxHint: '点击并拖拽创建旋转框',
  keypointHint: '点击放置关键点，按Enter完成',
};

const en: Record<string, string> = {
  fileList: 'File List', dropHint: 'Drop images or folder here\nor click to select',
  welcomeText: 'Drop images here to start annotating', welcomeHint: 'Supports JPG, PNG, BMP, WebP',
  noFile: 'No file', noChanges: 'No changes', properties: 'Properties',
  annotationInfo: 'Annotation Info', classList: 'Class List', export: 'Export',
  selectHint: 'Select an annotation to view properties', addClassPlaceholder: 'Add new class...',
  selectTool: 'Select/Move', rectTool: 'Rectangle', polygonTool: 'Polygon',
  rotatedTool: 'Rotated Box', keypointTool: 'Keypoint', magicWandTool: 'Magic Wand', samTool: 'SAM Segment',
  saved: 'Saved', unsaved: 'Unsaved', empty: 'No file',
  exportSuccess: 'Export successful', exportFailed: 'Export failed',
  importSuccess: 'Import successful', importFailed: 'Import failed',
  autoSaved: 'Auto-saved', classAdded: 'Class added',
  classExists: 'Class already exists', annotationDeleted: 'Annotation deleted',
  settings: 'Settings', shortcuts: 'Shortcuts', language: 'Language',
  save: 'Save', cancel: 'Cancel', reset: 'Reset',
  shortcutConflict: 'Shortcut conflict',
  undo: 'Undo', redo: 'Redo', delete: 'Delete', copy: 'Copy',
  zoomIn: 'Zoom In', zoomOut: 'Zoom Out', fitScreen: 'Fit Screen',
  noAnnotations: 'No annotations to export',
  recording: 'Recording...', pressKey: 'Press key combination',
  importFolder: 'Import Folder', addFiles: 'Add Images',
  currentExport: 'Export Current', batchExportBtn: 'Batch Export',
  chooseFormat: 'Choose Format', exporting: 'Exporting...',
  exportComplete: 'Export Complete', exportedFiles: 'exported files',
  noImagesToExport: 'No annotations to export',
  totalImages: 'images', totalAnnotations: 'annotations',
  folderNotSupported: 'Browser does not support folder write',
  id: 'ID', type: 'Type', label: 'Label', coordinates: 'Coordinates',
  annotated: 'annotated',
  rectHint: 'Click and drag to create rectangle',
  polygonHint: 'Click to create polygon vertices, double-click or Enter to finish',
  rotateBoxHint: 'Click and drag to create rotated box',
  keypointHint: 'Click to place keypoints, press Enter to finish',
};

let currentLang = $state<Language>('zh');

export function t(key: string): string {
  const dict = currentLang === 'zh' ? zh : en;
  return dict[key] || key;
}

export function getLang(): Language { return currentLang; }

export function setLang(lang: Language) {
  currentLang = lang;
  localStorage.setItem('annotator_lang', lang);
}

export function initLang() {
  const saved = localStorage.getItem('annotator_lang');
  if (saved === 'en' || saved === 'zh') currentLang = saved;
}
