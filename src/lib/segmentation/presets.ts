/** 分割模式预置类别 —— 只是**快捷按钮**。
 *
 *  SAM3 的核心优势是开放词汇：输入框永远可以手打任意英文词（wire、crane、pothole…），
 *  预置表只解决「街景/自动驾驶场景下最常敲的那 19 个词」的点击成本。
 *  颜色取自 Cityscapes 官方调色板，P1b 导语义图时视觉上和训练集一致。
 */
import type { MaskRegionKind } from './types';

export interface SegPreset {
  name: string;
  kind: MaskRegionKind;
  color: string;
}

/** Cityscapes 19 个 trainId 类别（顺序即 trainId 0..18） */
export const SEG_PRESETS: SegPreset[] = [
  { name: 'road', kind: 'stuff', color: '#804080' },
  { name: 'sidewalk', kind: 'stuff', color: '#f423e8' },
  { name: 'building', kind: 'stuff', color: '#464646' },
  { name: 'wall', kind: 'stuff', color: '#66669c' },
  { name: 'fence', kind: 'stuff', color: '#be9999' },
  { name: 'pole', kind: 'stuff', color: '#999999' },
  { name: 'traffic light', kind: 'instance', color: '#faaa1e' },
  { name: 'traffic sign', kind: 'instance', color: '#dcdc00' },
  { name: 'vegetation', kind: 'stuff', color: '#6b8e23' },
  { name: 'terrain', kind: 'stuff', color: '#98fb98' },
  { name: 'sky', kind: 'stuff', color: '#4682b4' },
  { name: 'person', kind: 'instance', color: '#dc143c' },
  { name: 'rider', kind: 'instance', color: '#ff0000' },
  { name: 'car', kind: 'instance', color: '#00008e' },
  { name: 'truck', kind: 'instance', color: '#000046' },
  { name: 'bus', kind: 'instance', color: '#003c64' },
  { name: 'train', kind: 'instance', color: '#005064' },
  { name: 'motorcycle', kind: 'instance', color: '#0000e6' },
  { name: 'bicycle', kind: 'instance', color: '#770b20' },
];

/** Cityscapes 的 trainId（0..18，顺序与 SEG_PRESETS 一致）。
 *
 *  ⚠️ Cityscapes 官方是 **labelId(0..33)** 和 **trainId(0..18)** 两套编号，
 *  训练用的语义图几乎都是 trainId。这里存的是 trainId；没映射到的类别一律写 255(void)，
 *  **绝不能写 0**（0 在 Cityscapes 里是 road）。 */
export const CITYSCAPES_TRAIN_ID: Record<string, number> = Object.fromEntries(
  SEG_PRESETS.map((p, i) => [p.name, i])
);

export const DEFAULT_SEG_CLASSES: string[] = SEG_PRESETS.map(p => p.name);

export const DEFAULT_SEG_COLORS: Record<string, string> = Object.fromEntries(
  SEG_PRESETS.map(p => [p.name, p.color])
);

/** 天然是「一片」而不是「一个东西」的类别：即使面积不大也按 stuff 处理（只进语义图）。 */
export const STUFF_CLASSES = new Set<string>([
  'road', 'sidewalk', 'building', 'wall', 'fence', 'pole', 'vegetation', 'terrain',
  'sky', 'water', 'grass', 'ground', 'floor', 'mountain', 'river', 'sea', 'sand',
  'parking', 'bridge', 'rail track', 'snow', 'cloud', 'tree', 'hedge', 'curb',
  'crosswalk', 'lane marking', 'guardrail',
]);

/** 判定候选是 thing 还是 stuff。
 *
 *  1. 类别在 STUFF_CLASSES 里 → stuff；
 *  2. 否则看面积占比：超过 35% 的「car」多半是 SAM 把整片停车场当成了车，
 *     这种时候按 stuff 处理（只进语义图）比塞一堆实例进实例层更合理。
 */
export function inferKind(className: string, areaRatio: number): MaskRegionKind {
  const cls = (className || '').trim().toLowerCase();
  if (STUFF_CLASSES.has(cls)) return 'stuff';
  if (areaRatio > 0.35) return 'stuff';
  return 'instance';
}

/** 新类别的兜底配色（预置表之外的开放词汇） */
export const EXTRA_SEG_COLORS = [
  '#58a6ff', '#3fb950', '#d2991d', '#f85149', '#a371f7', '#39d2c0', '#db6dab', '#8b949e',
  '#ff9f1c', '#2ec4b6', '#e71d36', '#7f8c8d',
];

export function colorForNewSegClass(existingCount: number): string {
  return EXTRA_SEG_COLORS[existingCount % EXTRA_SEG_COLORS.length];
}

/** 驾驶场景的中文长尾词。
 *
 *  刻意**不**写进 `sam.ts` 的 `PROMPT_ZH_TO_EN`：那是检测模式的共用映射表，
 *  改它等于动现有模式的行为（铁律 A）。分割模式先查这张表，查不到再退回 sam.ts 的映射，
 *  两张表都查不到就原样发（SAM3 对英文开放词汇，本来就是随便敲）。 */
export const SEG_ZH_TO_EN: Record<string, string> = {
  '人行道': 'sidewalk', '红绿灯': 'traffic light', '交通信号灯': 'traffic light',
  '交通标志': 'traffic sign', '路牌': 'traffic sign', '护栏': 'fence', '栏杆': 'fence',
  '电线杆': 'pole', '骑手': 'rider', '骑车人': 'rider', '植被': 'vegetation',
  '绿化带': 'vegetation', '树木': 'tree', '斑马线': 'crosswalk', '车道线': 'lane marking',
  '路缘石': 'curb', '路面': 'road', '道路': 'road', '马路': 'road', '街道': 'road',
  '行人': 'person', '卡车': 'truck', '公交车': 'bus', '摩托车': 'motorcycle',
  '自行车': 'bicycle', '汽车': 'car', '轿车': 'car', '天空': 'sky', '建筑': 'building',
  '楼房': 'building', '围墙': 'wall', '墙': 'wall', '推土机': 'bulldozer', '卡车头': 'truck',
};
