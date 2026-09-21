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
}

/** COCO 人体 17 关键点 */
const COCO_BODY: SkeletonTemplate = {
  id: 'coco_body',
  name: 'COCO 人体 (17点)',
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

/** 兼容旧 import */
export const SKELETON_TEMPLATES: SkeletonTemplate[] = BUILTIN_SKELETONS;

/** 删除自定义模板 */
export function deleteCustomSkeleton(id: string) {
  customSkeletons = customSkeletons.filter(s => s.id !== id);
  saveCustom();
}

/** 保存/更新自定义模板 */
export function upsertCustomSkeleton(tpl: SkeletonTemplate) {
  const idx = customSkeletons.findIndex(s => s.id === tpl.id);
  if (idx >= 0) customSkeletons[idx] = tpl;
  else customSkeletons = [...customSkeletons, tpl];
  saveCustom();
}
