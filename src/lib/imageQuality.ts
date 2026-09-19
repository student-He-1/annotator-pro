// 图片质量筛查：模糊检测、过暗/过亮检测、重复图片检测

export interface ImageQualityConfig {
  blurThreshold: number;      // 模糊阈值（拉普拉斯方差，低于此值判定模糊）
  darkThreshold: number;      // 过暗阈值（平均亮度0-255，低于此值判定过暗）
  brightThreshold: number;    // 过亮阈值（平均亮度0-255，高于此值判定过亮）
  duplicateThreshold: number; // 重复阈值（dHash汉明距离，<=此值判定相似）
  checkBlur: boolean;
  checkBrightness: boolean;
  checkDuplicate: boolean;
}

export const DEFAULT_IMAGE_QUALITY_CONFIG: ImageQualityConfig = {
  blurThreshold: 100,
  darkThreshold: 30,
  brightThreshold: 230,
  duplicateThreshold: 5,
  checkBlur: true,
  checkBrightness: true,
  checkDuplicate: true,
};

export type ImageQualityIssueType = 'blur' | 'too_dark' | 'too_bright' | 'duplicate';
export type ImageQualitySeverity = 'error' | 'warning';

export interface ImageQualityIssue {
  type: ImageQualityIssueType;
  severity: ImageQualitySeverity;
  image: string;
  message: string;
  detail?: string;
  duplicateOf?: string; // 重复时指向另一张图片名
}

export interface ImageQualityReport {
  totalImages: number;
  issues: ImageQualityIssue[];
  issueCounts: Record<string, number>;
  passed: boolean;
  blurScores: Record<string, number>;   // 图片名 -> 模糊度
  brightnessScores: Record<string, number>; // 图片名 -> 平均亮度
}

// 转灰度
function toGray(data: Uint8ClampedArray): number[] {
  const gray: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    gray.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  return gray;
}

// 拉普拉斯方差（模糊检测）
function laplacianVariance(gray: number[], width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0, sumSq = 0, count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const lap = 4 * gray[idx] - gray[idx - 1] - gray[idx + 1] - gray[idx - width] - gray[idx + width];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

// 平均亮度
function averageBrightness(gray: number[]): number {
  if (gray.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  return sum / gray.length;
}

// dHash（差异哈希）：缩放至9x8，比较相邻像素产生64位哈希
function dHashFromImageData(data: Uint8ClampedArray, width: number, height: number): bigint {
  const gray = toGray(data);
  // 9列8行，比较每行相邻2个像素（8个比较），共64位
  let hash = 0n;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const idx = y * width + x;
      hash = (hash << 1n) | (gray[idx] > gray[idx + 1] ? 1n : 0n);
    }
  }
  return hash;
}

// 汉明距离
function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let dist = 0;
  while (xor > 0n) {
    dist += Number(xor & 1n);
    xor >>= 1n;
  }
  return dist;
}

// 从图片元素获取 ImageData（缩放到指定尺寸）
function getImageData(img: HTMLImageElement, scaleW: number, scaleH: number): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = scaleW;
  canvas.height = scaleH;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, scaleW, scaleH);
  return ctx.getImageData(0, 0, scaleW, scaleH);
}

// 加载图片为 HTMLImageElement
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export interface ImageInfo {
  name: string;
  dataUrl: string;
  width: number;
  height: number;
}

// 主函数：批量图片质量筛查
export async function runImageQualityCheck(
  images: ImageInfo[],
  config: ImageQualityConfig = DEFAULT_IMAGE_QUALITY_CONFIG,
): Promise<ImageQualityReport> {
  const issues: ImageQualityIssue[] = [];
  const blurScores: Record<string, number> = {};
  const brightnessScores: Record<string, number> = {};
  const hashes: { name: string; hash: bigint }[] = [];

  // 逐张图片检测
  for (const imgInfo of images) {
    try {
      const img = await loadImage(imgInfo.dataUrl);

      // 模糊检测：用较大尺寸（如256x256）计算拉普拉斯方差
      if (config.checkBlur) {
        const blurData = getImageData(img, 256, 256);
        const gray = toGray(blurData.data);
        const variance = laplacianVariance(gray, 256, 256);
        blurScores[imgInfo.name] = Math.round(variance);
        if (variance < config.blurThreshold) {
          issues.push({
            type: 'blur',
            severity: variance < config.blurThreshold * 0.5 ? 'error' : 'warning',
            image: imgInfo.name,
            message: `图片可能模糊（清晰度 ${Math.round(variance)}）`,
            detail: `拉普拉斯方差 ${Math.round(variance)}，阈值 ${config.blurThreshold}`,
          });
        }
      }

      // 亮度检测：用128x128计算平均亮度
      if (config.checkBrightness) {
        const brightData = getImageData(img, 128, 128);
        const gray = toGray(brightData.data);
        const avg = averageBrightness(gray);
        brightnessScores[imgInfo.name] = Math.round(avg);
        if (avg < config.darkThreshold) {
          issues.push({
            type: 'too_dark',
            severity: 'warning',
            image: imgInfo.name,
            message: `图片过暗（平均亮度 ${Math.round(avg)}）`,
            detail: `平均亮度 ${Math.round(avg)}/255，阈值 ${config.darkThreshold}`,
          });
        } else if (avg > config.brightThreshold) {
          issues.push({
            type: 'too_bright',
            severity: 'warning',
            image: imgInfo.name,
            message: `图片过亮（平均亮度 ${Math.round(avg)}）`,
            detail: `平均亮度 ${Math.round(avg)}/255，阈值 ${config.brightThreshold}`,
          });
        }
      }

      // dHash：缩放至9x8
      if (config.checkDuplicate) {
        const hashData = getImageData(img, 9, 8);
        const hash = dHashFromImageData(hashData.data, 9, 8);
        hashes.push({ name: imgInfo.name, hash });
      }
    } catch (e) {
      // 图片加载失败跳过
      console.warn(`Image quality check failed for ${imgInfo.name}:`, e);
    }
  }

  // 重复检测：比较所有图片对的 dHash
  if (config.checkDuplicate && hashes.length > 1) {
    const reported = new Set<string>();
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) {
        const dist = hammingDistance(hashes[i].hash, hashes[j].hash);
        if (dist <= config.duplicateThreshold) {
          const key = [hashes[i].name, hashes[j].name].sort().join('|');
          if (!reported.has(key)) {
            reported.add(key);
            issues.push({
              type: 'duplicate',
              severity: 'warning',
              image: hashes[i].name,
              message: `与 "${hashes[j].name}" 相似/重复`,
              detail: `dHash 汉明距离 ${dist}，阈值 ${config.duplicateThreshold}`,
              duplicateOf: hashes[j].name,
            });
          }
        }
      }
    }
  }

  // 统计各类型问题数量
  const issueCounts: Record<string, number> = {};
  for (const issue of issues) {
    issueCounts[issue.type] = (issueCounts[issue.type] || 0) + 1;
  }

  return {
    totalImages: images.length,
    issues,
    issueCounts,
    passed: issues.length === 0,
    blurScores,
    brightnessScores,
  };
}
