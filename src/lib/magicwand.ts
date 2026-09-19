/** 魔术棒工具 — 基于颜色相似度的 flood fill 区域分割 */

export interface MagicWandConfig {
  tolerance: number;      // 颜色容差 0-255
  useContiguous: boolean;  // 是否只选连通区域（true=flood fill, false=全局颜色匹配）
  simplifyTolerance: number; // 多边形简化阈值（像素）
}

export const DEFAULT_MAGIC_WAND_CONFIG: MagicWandConfig = {
  tolerance: 32,
  useContiguous: true,
  simplifyTolerance: 3,
};

interface Pixel {
  x: number;
  y: number;
}

/**
 * 计算两个颜色的欧氏距离
 */
function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.sqrt(
    (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2
  );
}

/**
 * Flood fill — 找到与起始点颜色相近的连通区域
 * 返回选中像素的 mask（Uint8Array，1=选中，0=未选中）
 */
export function floodFill(
  imageData: ImageData,
  startX: number,
  startY: number,
  tolerance: number
): Uint8Array {
  const { width, height, data } = imageData;
  const mask = new Uint8Array(width * height);

  const startIdx = (startY * width + startX) * 4;
  const startR = data[startIdx];
  const startG = data[startIdx + 1];
  const startB = data[startIdx + 2];

  const tolSq = tolerance * tolerance * 3; // 提前平方，避免开方

  const stack: Pixel[] = [{ x: startX, y: startY }];
  mask[startY * width + startX] = 1;

  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1], // 8邻域
  ];

  while (stack.length > 0) {
    const { x, y } = stack.pop()!;

    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;

      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (mask[ny * width + nx]) continue;

      const idx = (ny * width + nx) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      const distSq = (r - startR) ** 2 + (g - startG) ** 2 + (b - startB) ** 2;
      if (distSq <= tolSq) {
        mask[ny * width + nx] = 1;
        stack.push({ x: nx, y: ny });
      }
    }
  }

  return mask;
}

/**
 * 全局颜色匹配 — 选中所有颜色相近的像素（不要求连通）
 */
export function globalColorMatch(
  imageData: ImageData,
  startX: number,
  startY: number,
  tolerance: number
): Uint8Array {
  const { width, height, data } = imageData;
  const mask = new Uint8Array(width * height);

  const startIdx = (startY * width + startX) * 4;
  const startR = data[startIdx];
  const startG = data[startIdx + 1];
  const startB = data[startIdx + 2];

  const tolSq = tolerance * tolerance * 3;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const distSq = (r - startR) ** 2 + (g - startG) ** 2 + (b - startB) ** 2;
      if (distSq <= tolSq) {
        mask[y * width + x] = 1;
      }
    }
  }

  return mask;
}

/**
 * 从 mask 提取轮廓点（Moore 邻域轮廓跟踪算法）
 * 沿着边界像素连续跟踪，生成闭合有序的多边形点列
 */
export function extractContour(mask: Uint8Array, width: number, height: number): Pixel[] {
  // 找到起始点（最左上角的选中像素）
  let startX = -1, startY = -1;
  outer: for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }

  if (startX < 0) return [];

  const isInside = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    return mask[y * width + x] === 1;
  };

  // Moore 邻域：8个方向，从右侧开始顺时针
  // 索引顺序：E, SE, S, SW, W, NW, N, NE
  const dirs: [number, number][] = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1],
  ];

  const contour: Pixel[] = [];
  let cx = startX, cy = startY;
  let prevDir = 6; // 从 N 方向开始搜索（上一个方向）

  contour.push({ x: cx, y: cy });

  const maxSteps = width * height; // 防止死循环
  let steps = 0;

  while (steps++ < maxSteps) {
    // 从 prevDir+1 开始顺时针搜索下一个边缘点
    let found = false;
    for (let i = 1; i <= 8; i++) {
      const dirIdx = (prevDir + i) % 8;
      const [dx, dy] = dirs[dirIdx];
      const nx = cx + dx;
      const ny = cy + dy;

      if (isInside(nx, ny)) {
        // 下一个边界点
        cx = nx;
        cy = ny;
        // 计算回溯方向：相对当前方向的反方向的前一个
        // Moore 邻域规则：下一轮搜索从 (dirIdx + 6) % 8 开始
        prevDir = (dirIdx + 6) % 8;
        found = true;
        break;
      }
    }

    if (!found) break; // 孤立点，没有邻居

    // 回到起点则结束
    if (cx === startX && cy === startY) break;

    contour.push({ x: cx, y: cy });
  }

  return contour;
}

/**
 * Douglas-Peucker 多边形简化算法
 */
function douglasPeucker(points: Pixel[], tolerance: number): Pixel[] {
  if (points.length <= 2) return points;

  const perpDistance = (p: Pixel, lineStart: Pixel, lineEnd: Pixel): number => {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const mag = Math.sqrt(dx * dx + dy * dy);
    if (mag === 0) return Math.hypot(p.x - lineStart.x, p.y - lineStart.y);
    return Math.abs(dy * p.x - dx * p.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x) / mag;
  };

  let maxDist = 0;
  let maxIndex = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpDistance(points[i], points[0], points[points.length - 1]);
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }

  if (maxDist > tolerance) {
    const left = douglasPeucker(points.slice(0, maxIndex + 1), tolerance);
    const right = douglasPeucker(points.slice(maxIndex), tolerance);
    return left.slice(0, -1).concat(right);
  } else {
    return [points[0], points[points.length - 1]];
  }
}

/**
 * 简化多边形点 — 先用距离过滤密集点，再用 Douglas-Peucker
 */
export function simplifyPolygon(points: Pixel[], tolerance: number): Pixel[] {
  if (points.length <= 3) return points;

  // 第一步：最小距离过滤（相邻点距离小于 tolerance 的合并）
  const filtered: Pixel[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const last = filtered[filtered.length - 1];
    if (Math.hypot(points[i].x - last.x, points[i].y - last.y) >= tolerance) {
      filtered.push(points[i]);
    }
  }

  if (filtered.length <= 3) return filtered;

  // 第二步：Douglas-Peucker 简化
  return douglasPeucker(filtered, tolerance);
}

/**
 * 完整的魔术棒流程：点击 → flood fill → 轮廓提取 → 多边形简化
 * 返回多边形顶点数组（原始图片坐标）
 */
export function magicWand(
  imageData: ImageData,
  clickX: number,
  clickY: number,
  config: MagicWandConfig
): { x: number; y: number }[] {
  const { width, height } = imageData;

  // 边界检查
  if (clickX < 0 || clickX >= width || clickY < 0 || clickY >= height) {
    return [];
  }

  // 性能优化：大图自动降采样（最大边 1500px），处理完再放大回去
  const MAX_SIZE = 1500;
  const maxDim = Math.max(width, height);
  const scale = maxDim > MAX_SIZE ? MAX_SIZE / maxDim : 1;

  let workImage = imageData;
  let workClickX = clickX;
  let workClickY = clickY;
  let workWidth = width;
  let workHeight = height;

  if (scale < 1) {
    workWidth = Math.round(width * scale);
    workHeight = Math.round(height * scale);
    workClickX = Math.round(clickX * scale);
    workClickY = Math.round(clickY * scale);
    // 用 OffscreenCanvas 降采样
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(imageData, 0, 0);
    // 重新创建 canvas 缩放
    const scaledCanvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(workWidth, workHeight)
      : Object.assign(document.createElement('canvas'), { width: workWidth, height: workHeight });
    const scaledCtx = scaledCanvas.getContext('2d')!;
    scaledCtx.drawImage(canvas, 0, 0, workWidth, workHeight);
    workImage = scaledCtx.getImageData(0, 0, workWidth, workHeight);
  }

  // 1. 区域选择
  const mask = config.useContiguous
    ? floodFill(workImage, workClickX, workClickY, config.tolerance)
    : globalColorMatch(workImage, workClickX, workClickY, config.tolerance);

  // 2. 轮廓提取
  const contour = extractContour(mask, workWidth, workHeight);

  if (contour.length < 3) return [];

  // 3. 多边形简化
  const simplified = simplifyPolygon(contour, config.simplifyTolerance);

  if (simplified.length < 3) return contour.slice(0, Math.min(contour.length, 50)).map(p => ({ x: p.x / scale, y: p.y / scale }));

  // 限制最大点数，避免多边形过于复杂
  const maxPoints = 200;
  let result = simplified;
  if (result.length > maxPoints) {
    const step = result.length / maxPoints;
    const sampled: Pixel[] = [];
    for (let i = 0; i < maxPoints; i++) {
      sampled.push(result[Math.floor(i * step)]);
    }
    result = sampled;
  }

  // 坐标放大回原始大小
  return result.map(p => ({ x: Math.round(p.x / scale), y: Math.round(p.y / scale) }));
}
