/** 图像分割模式的数据模型（与检测/分类模式完全独立）。
 *
 *  唯一真值 = 一张与原图同尺寸的索引图：0 = 背景，k = 第 k 个 region（1-based）。
 *  内存里只保「行程编码 + 区域清单」，解码出来的整图（W*H 字节）只按 LRU 留 1~2 张，
 *  并且**绝不放进 $state**（深代理会把 2 MB 的 Uint8Array 包成一堆 getter）。
 */

/** 区域语义：thing 有实例身份（car/person），stuff 是背景材质（road/sky）。 */
export type MaskRegionKind = 'instance' | 'stuff';

/** 区域是怎么来的 */
export type MaskRegionSource = 'pcs' | 'point' | 'box' | 'brush';

export interface MaskBox { x1: number; y1: number; x2: number; y2: number }

export interface MaskRegion {
  /** 索引图像素值，1-based，恒等于 regions 数组下标 + 1（删除后必须 repack） */
  ordinal: number;
  className: string;
  kind: MaskRegionKind;
  score: number;
  source: MaskRegionSource;
  box?: MaskBox;
  /** 像素数，接受时算一次 */
  area?: number;
  hidden?: boolean;
  /** 「严格重叠」开启时才写：被后续区域覆盖掉的像素行程（"start:len,..."，行主序）。
   *  显示仍以索引图为准；COCO 实例导出会把这段并回实例。旧工程没有该字段。 */
  occluded?: string;
}

/** 内存里的掩膜（紧凑形态，不含解码图） */
export interface ImageMask {
  width: number;
  height: number;
  /** 行主序行程长度；与 ids 一一对应 */
  counts: number[];
  /** 每个行程的值：0 = 背景，k = ordinal。见 rle.ts 顶部为什么需要这一路 */
  ids: number[];
  regions: MaskRegion[];
}

/** 工程文件里的掩膜（两个数组都落成逗号串，绝不存 JSON 数组） */
export interface ProjectMask {
  width: number;
  height: number;
  counts: string;
  ids: string;
  regions: MaskRegion[];
}

/** 候选实例（文本/点提示返回、还没被接受） */
export interface MaskCandidate {
  /** 候选索引图里的值（1-based），接受时就把它并进正式索引图 */
  k: number;
  className: string;
  kind: MaskRegionKind;
  score: number;
  area: number;
  box?: MaskBox;
}

/** 跨图复核队列的候选项：只存二值掩膜的 RLE，不存整图 map（避免大工程常驻几十 MB） */
export interface ReviewQueueItem {
  /** 稳定标识：图片 + 类别 + 分数 + box + 面积（用于去重/移除） */
  id: string;
  imageName: string;
  className: string;
  kind: MaskRegionKind;
  score: number;
  area: number;
  box?: MaskBox;
  /** 整图尺寸（复核时用来还原成整图候选 map） */
  width: number;
  height: number;
  /** 候选二值掩膜只存 bbox 内的 RLE，避免每个候选都分配/压缩一张整图 */
  x0: number;
  y0: number;
  bw: number;
  bh: number;
  counts: number[];
  ids: number[];
}

/** 面板展示用的轻量元数据（不含 RLE 数组） */
export type ReviewQueueMeta = Omit<ReviewQueueItem, 'counts' | 'ids'>;

/** 「一键全类扫描」里单个类别的结果 */
export interface SegSweepResult {
  className: string;
  /** 这个类别一共命中几个候选 */
  total: number;
  /** 分数够高、已经自动接受的数量 */
  accepted: number;
  /** 分数在中间带、留着让用户复核的数量 */
  review: number;
  elapsedMs: number;
  error?: string;
}

/** 工程文件里的分割设置（全部可选，旧工程零改动可读） */
export interface SegmentationSettings {
  overlayMode?: 'instance' | 'class';
  overlayOpacity?: number;
  /** 类别名 → Cityscapes trainId（P1b 导出用） */
  cityscapesMap?: Record<string, number>;
  /** 分割模式自己的类别表，不污染检测/分类的 classes */
  classes?: string[];
  classColors?: Record<string, string>;
  /** 严格重叠：接受候选时额外记录被覆盖像素（默认关闭） */
  strictOverlap?: boolean;
}
