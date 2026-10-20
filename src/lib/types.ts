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
  /** SAM 工具（M）。曾经漏在这里，重置快捷键时会被整个抹掉 → M 键永久失效 */
  sam: string;
  /** 魔术棒（W）。工具栏一直标着 W，但之前既没字段也没接键 */
  magicwand: string;
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
  /** 该图片的分类标签（分类模式专用）。
   *  以前只存 annotations，于是分类模式下 Ctrl+Z 是个「撤了但什么都没变」的空操作。
   *  旧的历史条目/旧工程里没有这个字段，用 `|| []` 兜底。 */
  labels?: string[];
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
  /** 分类模式的图片标签（buildProjectFile 会写，可缺省） */
  imageLabels?: Record<string, string[]>;
  classes: string[];
  classColors: Record<string, string>;
  settings: {
    exportFormat: ExportFormat;
    skeletonId: string;
    /** 工程所属工作模式 */
    workMode?: 'detection' | 'classification';
  };
}
