/** 标注类型 */
export type AnnotationType = 'rect' | 'polygon' | 'rotated' | 'keypoint';

/** 标注工具 */
export type ToolType = 'select' | AnnotationType | 'magicwand' | 'sam';

/** 点坐标 */
export interface Point { x: number; y: number }

/** 矩形标注 */
export interface RectAnnotation {
  type: 'rect';
  id: number;
  className: string;
  x: number; y: number;
  w: number; h: number;
  trackId?: number;
}

/** 多边形标注 */
export interface PolygonAnnotation {
  type: 'polygon';
  id: number;
  className: string;
  points: Point[];
  trackId?: number;
}

/** 旋转框标注 */
export interface RotatedAnnotation {
  type: 'rotated';
  id: number;
  className: string;
  cx: number; cy: number;
  w: number; h: number;
  angle: number;
  trackId?: number;
}

/** 关键点标注 */
export interface KeypointAnnotation {
  type: 'keypoint';
  id: number;
  className: string;
  points: Point[];
  trackId?: number;
}

/** 联合标注类型 */
export type Annotation = RectAnnotation | PolygonAnnotation | RotatedAnnotation | KeypointAnnotation;

/** 图片信息 */
export interface ImageInfo {
  name: string;
  dataUrl: string;
  width: number;
  height: number;
  /// 完整文件路径（sidecar 用，浏览器导入时为空）
  path?: string;
}

/** 快捷键配置 */
export interface ShortcutMap {
  select: string; rect: string; polygon: string; rotated: string; keypoint: string;
  undo: string; redo: string; redoAlt: string;
  delete: string; copy: string;
  zoomIn: string; zoomOut: string; fit: string;
  save: string;
}

/** 导出格式 */
export type ExportFormat = 'voc' | 'yolo' | 'coco' | 'coco_merged' | 'createml' | 'labelme' | 'png' | 'jpg' | 'classification_csv' | 'unet_mask';

/** 语言 */
export type Language = 'zh' | 'en';

/** 拖拽把手 */
export interface DragHandle {
  id: 'tl' | 'tr' | 'bl' | 'br' | 'tm' | 'bm' | 'ml' | 'mr';
  x: number; y: number;
}

/** 历史记录条目 */
export interface HistoryEntry {
  imageName: string;
  annotations: Annotation[];
}

/** 工程文件中的图片条目 */
export interface ProjectImage {
  name: string;
  path: string;       // 绝对路径，纯浏览器环境为空
  width: number;
  height: number;
}

/** 工程文件格式 (.annotator) */
export interface ProjectFile {
  version: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  images: ProjectImage[];
  annotations: Record<string, Annotation[]>;
  classes: string[];
  classColors: Record<string, string>;
  settings: {
    exportFormat: ExportFormat;
    skeletonId: string;
  };
}
