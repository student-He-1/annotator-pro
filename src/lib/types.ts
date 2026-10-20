/** 分割模式的工程数据类型（只在分割模式用；旧工程不带这些字段） */
import type { ProjectMask, SegmentationSettings } from './segmentation/types';

/** 标注类型 */
export type AnnotationType = 'rect' | 'polygon' | 'rotated' | 'keypoint';

/** 标注工具 */
export type ToolType = 'select' | AnnotationType | 'magicwand' | 'sam'
  /** 分割模式工具（第三个模式）。前缀 seg_ 保证和上面检测模式的工具名不冲突 */
  | 'seg_select' | 'seg_text' | 'seg_point' | 'seg_box'
  /** 修正工具 */
  | 'seg_brush' | 'seg_eraser' | 'seg_refine';

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
  /** 这条骨架用的是哪个模板（coco_body / face_68 / hand_21 / custom_xxx / none）。
   *  以前没有这个字段，只能按「点数」反推模板 —— 手动打的点数量和模板对不上，
   *  就永远匹配不到骨架线，导出也不认它。旧工程没有该字段时仍按点数兜底。 */
  skeletonId?: string;
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
export type ExportFormat = 'voc' | 'yolo' | 'coco' | 'coco_merged' | 'createml' | 'labelme' | 'png' | 'jpg' | 'classification_csv' | 'unet_mask'
  /** 分割模式的四种导出（走 lib/export/segmentation-export.ts，不进 formats.ts 的旧 case） */
  | 'seg_coco' | 'seg_coco_merged' | 'seg_cityscapes' | 'seg_instances' | 'seg_unet';

/** 语言 */
export type Language = 'zh' | 'en';

/** 拖拽把手 */
export interface DragHandle {
  id: 'tl' | 'tr' | 'bl' | 'br' | 'tm' | 'bm' | 'ml' | 'mr';
  x: number; y: number;
}

/** 一次操作对「某一张图」的快照（annotations + 分类标签）。
 *  撤销/重做的最小单位从「单图」升级成「多图」之后，一条历史由若干张这样的快照组成。 */
export interface ImageSnapshot {
  imageName: string;
  annotations: Annotation[];
  /** 该图片的分类标签（分类模式专用）。旧数据可能没有，用 `|| []` 兜底。 */
  labels: string[];
}

/** 历史记录条目。
 *  以前是**单图**结构（`{ imageName, annotations, labels }`），于是批量操作
 *  （批量改类别 / 批量删除 / YOLO·SAM 批量预标注）一次改了 N 张图，
 *  却只记了当前图那一张 —— 历史从这里开始错位，Ctrl+Z 撤的是别的一张图的上一步。
 *  现在一条记录可以携带「本次操作涉及的所有图」，undo/redo 整体写回。 */
export interface HistoryEntry {
  changes: ImageSnapshot[];
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
  /** 分割模式的掩膜（可缺省：旧工程没有这个字段照样打开，反之亦然） */
  masks?: Record<string, ProjectMask>;
  classes: string[];
  classColors: Record<string, string>;
  settings: {
    exportFormat: ExportFormat;
    skeletonId: string;
    /** 工程所属工作模式 */
    workMode?: 'detection' | 'classification' | 'segmentation';
    /** 分割模式的显示/类别设置（可缺省） */
    segmentation?: SegmentationSettings;
  };
}
