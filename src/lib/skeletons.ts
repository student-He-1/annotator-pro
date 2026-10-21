/** 关键点骨架模板定义 */

export interface SkeletonTemplate {
  id: string;
  name: string;
  /** 关键点名称列表，顺序即标注顺序 */
  keypoints: string[];
  /** 连线定义，每对为关键点索引 */
  skeleton: [number, number][];
  /** 关键点颜色（可选，按索引） */
  colors?: string[];
  /** 导出时用的类别名（英文）。
   *  关键点标注的 className 在语义上其实是「骨架类型」，不是目标类别 ——
   *  导出 COCO / LabelMe 时应该用它，而不是当前激活的类别（以前会导出成
   *  「person」这种靠运气对上的名字，或者干脆变成用户随手选的类别）。 */
  exportName?: string;
}

/** COCO 人体 17 关键点 */
const COCO_BODY: SkeletonTemplate = {
  id: 'coco_body',
  name: 'COCO 人体 (17点)',
  exportName: 'person',
  keypoints: [
    'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
    'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
    'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
    'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
  ],
  skeleton: [
    [0, 1], [0, 2], [1, 3], [2, 4],           // 头部
    [5, 6],                                     // 肩膀连线
    [5, 7], [7, 9], [6, 8], [8, 10],          // 手臂
    [5, 11], [6, 12], [11, 12],                // 躯干
    [11, 13], [13, 15], [12, 14], [14, 16],   // 腿
  ],
  colors: [
    '#f85149', '#f85149', '#f85149', '#f85149', '#f85149',  // 头部 红
    '#58a6ff', '#58a6ff', '#58a6ff', '#58a6ff', '#58a6ff', '#58a6ff',  // 手臂 蓝
    '#3fb950', '#3fb950', '#3fb950', '#3fb950', '#3fb950', '#3fb950', '#3fb950',  // 躯干+腿 绿
  ],
};

/** 面部 68 关键点（简化版） */
const FACE_68: SkeletonTemplate = {
  id: 'face_68',
  name: '面部 (68点)',
  exportName: 'face',
  keypoints: Array.from({ length: 68 }, (_, i) => `pt_${i + 1}`),
  skeleton: [
    // 脸型轮廓 0-16
    ...Array.from({ length: 16 }, (_, i) => [i, i + 1] as [number, number]),
    // 左眉 17-21
    ...Array.from({ length: 4 }, (_, i) => [17 + i, 18 + i] as [number, number]),
    // 右眉 22-26
    ...Array.from({ length: 4 }, (_, i) => [22 + i, 23 + i] as [number, number]),
    // 鼻梁 27-30
    ...Array.from({ length: 3 }, (_, i) => [27 + i, 28 + i] as [number, number]),
    // 鼻尖 31-35
    [31, 32], [32, 33], [33, 34], [34, 35],
    // 左眼 36-41
    [36, 37], [37, 38], [38, 39], [39, 40], [40, 41], [41, 36],
    // 右眼 42-47
    [42, 43], [43, 44], [44, 45], [45, 46], [46, 47], [47, 42],
    // 外唇 48-59
    [48, 49], [49, 50], [50, 51], [51, 52], [52, 53], [53, 54],
    [54, 55], [55, 56], [56, 57], [57, 58], [58, 59], [59, 48],
    // 内唇 60-67
    [60, 61], [61, 62], [62, 63], [63, 64], [64, 65], [65, 66], [66, 67], [67, 60],
  ],
};

/** 手部 21 关键点（MediaPipe） */
const HAND_21: SkeletonTemplate = {
  id: 'hand_21',
  name: '手部 (21点)',
  exportName: 'hand',
  keypoints: [
    'wrist',
    'thumb_cmc', 'thumb_mcp', 'thumb_ip', 'thumb_tip',
    'index_mcp', 'index_pip', 'index_dip', 'index_tip',
    'middle_mcp', 'middle_pip', 'middle_dip', 'middle_tip',
    'ring_mcp', 'ring_pip', 'ring_dip', 'ring_tip',
    'pinky_mcp', 'pinky_pip', 'pinky_dip', 'pinky_tip',
  ],
  skeleton: [
    [0, 1], [1, 2], [2, 3], [3, 4],             // 拇指
    [0, 5], [5, 6], [6, 7], [7, 8],             // 食指
    [5, 9], [9, 10], [10, 11], [11, 12],        // 中指
    [9, 13], [13, 14], [14, 15], [15, 16],      // 无名指
    [13, 17], [17, 18], [18, 19], [19, 20],     // 小指
    [0, 17],                                        // 手掌
  ],
};

/** 无骨架（自由散点） */
const NONE: SkeletonTemplate = {
  id: 'none',
  name: '无骨架（自由点）',
  keypoints: [],
  skeleton: [],
};

export const BUILTIN_SKELETONS: SkeletonTemplate[] = [
  NONE,
  COCO_BODY,
  HAND_21,
  FACE_68,
];

const CUSTOM_KEY = 'custom_skeletons';

export let customSkeletons: SkeletonTemplate[] = loadCustom();

function loadCustom(): SkeletonTemplate[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr;
    return [];
  } catch { return []; }
}

export function saveCustom() {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(customSkeletons));
}

export function getAllSkeletons(): SkeletonTemplate[] {
  return [...BUILTIN_SKELETONS, ...customSkeletons];
}

export function getSkeleton(id: string): SkeletonTemplate {
  return getAllSkeletons().find(s => s.id === id) || NONE;
}

// ============================================================
// 关键点标注 → 骨架类型解析
// ============================================================
// 新的关键点标注会在自己的 `skeletonId` 上记住用的是哪个模板；只有旧数据
// （没有该字段）才退回到「按点数猜」：17→人体, 68→人脸, 21→手。
// 渲染、导出、面板显示都走下面这几个函数，避免三处各写一份、各猜各的。

/** 按点数匹配骨架模板（跳过「无骨架」）。 */
export function skeletonForPointCount(n: number): SkeletonTemplate | undefined {
  return getAllSkeletons().find(t => t.id !== 'none' && t.keypoints.length === n);
}

/** 解析一条关键点标注该用哪个骨架模板。
 *  优先用标注自带的 skeletonId，没有才按点数兜底。 */
export function skeletonFor(skeletonId: string | undefined, pointCount: number): SkeletonTemplate | undefined {
  if (skeletonId && skeletonId !== 'none') {
    const hit = getAllSkeletons().find(s => s.id === skeletonId);
    if (hit) return hit;
  }
  return skeletonForPointCount(pointCount);
}

/** 导出用的类别名（英文，外部工具认）：person / face / hand / keypoint */
export function keypointExportName(pointCount: number, skeletonId?: string): string {
  return skeletonFor(skeletonId, pointCount)?.exportName || 'keypoint';
}

/** 界面显示用的骨架名（中文）：COCO 人体 (17点) / 面部 (68点) / ... */
export function keypointDisplayName(pointCount: number, skeletonId?: string): string {
  return skeletonFor(skeletonId, pointCount)?.name || `${pointCount} 点自由点`;
}

/** 兼容旧 import */
export const SKELETON_TEMPLATES: SkeletonTemplate[] = BUILTIN_SKELETONS;

/** 删除自定义模板 */
export function deleteCustomSkeleton(id: string) {
  customSkeletons = customSkeletons.filter(s => s.id !== id);
  saveCustom();
}

/** 合并工程文件里带的自定义模板定义。
 *  换机器打开工程时本机没有这些模板，关键点会退化成「按点数猜」。
 *  规则：**本机已有同 id 的优先**（不覆盖），内置模板也不会被顶替；
 *  只补齐本机缺失的、结构完整的模板，落盘一次，返回新增数量。 */
export function mergeCustomSkeletons(tpls: SkeletonTemplate[]): number {
  const existing = new Set(customSkeletons.map(s => s.id));
  const builtin = new Set(BUILTIN_SKELETONS.map(s => s.id));
  const incoming = tpls.filter(t =>
    !!t && typeof t.id === 'string' && t.id !== '' &&
    typeof t.name === 'string' &&
    Array.isArray(t.keypoints) && Array.isArray(t.skeleton) &&
    !existing.has(t.id) && !builtin.has(t.id)
  );
  if (incoming.length === 0) return 0;
  // 深拷贝，避免工程对象与 store 共享引用
  customSkeletons = [...customSkeletons, ...JSON.parse(JSON.stringify(incoming))];
  saveCustom();
  return incoming.length;
}

/** 保存/更新自定义模板 */
export function upsertCustomSkeleton(tpl: SkeletonTemplate) {
  const idx = customSkeletons.findIndex(s => s.id === tpl.id);
  if (idx >= 0) customSkeletons[idx] = tpl;
  else customSkeletons = [...customSkeletons, tpl];
  saveCustom();
}
