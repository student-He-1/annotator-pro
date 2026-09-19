/** 数据集划分工具 — train/val/test 按比例随机划分 */
import { images, annotations } from './state.svelte';

export interface SplitConfig {
  train: number;  // 0-1
  val: number;    // 0-1
  test: number;   // 0-1
  seed?: number;  // 随机种子，保证可复现
  onlyAnnotated?: boolean; // 只划分有标注的图片
}

export interface SplitResult {
  train: string[];  // 图片名列表
  val: string[];
  test: string[];
  stats: {
    total: number;
    train: number;
    val: number;
    test: number;
    trainAnns: number;
    valAnns: number;
    testAnns: number;
  };
}

// 简单的可复现随机数生成器（mulberry32）
function mulberry32(seed: number) {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * 执行数据集划分
 */
export function splitDataset(config: SplitConfig): SplitResult {
  const { train, val, test, seed = Date.now(), onlyAnnotated = false } = config;

  // 校验比例
  const total = train + val + test;
  if (Math.abs(total - 1) > 0.01) {
    throw new Error(`Split ratios must sum to 1, got ${total}`);
  }

  // 筛选图片
  let imgList = images.map(img => img.name);
  if (onlyAnnotated) {
    imgList = imgList.filter(name => (annotations[name]?.length || 0) > 0);
  }

  // Fisher-Yates 洗牌（可复现）
  const rng = mulberry32(seed);
  const shuffled = [...imgList];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // 划分
  const n = shuffled.length;
  const trainEnd = Math.round(n * train);
  const valEnd = trainEnd + Math.round(n * val);

  const trainSet = shuffled.slice(0, trainEnd);
  const valSet = shuffled.slice(trainEnd, valEnd);
  const testSet = shuffled.slice(valEnd);

  // 统计标注数
  const countAnns = (names: string[]) =>
    names.reduce((sum, name) => sum + (annotations[name]?.length || 0), 0);

  return {
    train: trainSet,
    val: valSet,
    test: testSet,
    stats: {
      total: n,
      train: trainSet.length,
      val: valSet.length,
      test: testSet.length,
      trainAnns: countAnns(trainSet),
      valAnns: countAnns(valSet),
      testAnns: countAnns(testSet),
    },
  };
}

/**
 * 导出划分文件（YOLO 格式的 train.txt/val.txt/test.txt）
 */
export function exportSplitFiles(result: SplitResult): { name: string; content: string }[] {
  const files: { name: string; content: string }[] = [];

  if (result.train.length > 0) {
    files.push({ name: 'train.txt', content: result.train.join('\n') + '\n' });
  }
  if (result.val.length > 0) {
    files.push({ name: 'val.txt', content: result.val.join('\n') + '\n' });
  }
  if (result.test.length > 0) {
    files.push({ name: 'test.txt', content: result.test.join('\n') + '\n' });
  }

  return files;
}
