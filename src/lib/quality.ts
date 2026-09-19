/** 标注质量校验工具 */
import { images, annotations, classes } from './state.svelte';
import type { Annotation, RectAnnotation, PolygonAnnotation, RotatedAnnotation } from './types';

export interface QualityIssue {
  type: 'unannotated' | 'empty_class' | 'overlap' | 'too_small' | 'out_of_bounds' | 'no_class';
  image: string;
  annotationId?: number;
  message: string;
  severity: 'warning' | 'error';
}

export interface QualityReport {
  totalImages: number;
  annotatedImages: number;
  unannotatedImages: number;
  totalAnnotations: number;
  issues: QualityIssue[];
  issueCounts: Record<string, number>;
  passed: boolean;
}

export interface QualityConfig {
  minBoxSize: number;       // 最小框尺寸（像素）
  overlapThreshold: number;  // 重叠 IoU 阈值（0-1）
  checkUnannotated: boolean;
  checkEmptyClass: boolean;
  checkOverlap: boolean;
  checkTooSmall: boolean;
  checkOutOfBounds: boolean;
}

export const DEFAULT_QUALITY_CONFIG: QualityConfig = {
  minBoxSize: 5,
  overlapThreshold: 0.8,
  checkUnannotated: true,
  checkEmptyClass: true,
  checkOverlap: true,
  checkTooSmall: true,
  checkOutOfBounds: true,
};

/** 计算两个矩形的 IoU */
function rectIoU(a: RectAnnotation, b: RectAnnotation): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = a.w * a.h;
  const areaB = b.w * b.h;
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

/** 获取标注的边界框 */
function getBoundingBox(ann: Annotation): { x: number; y: number; w: number; h: number } | null {
  if (ann.type === 'rect') {
    return { x: ann.x, y: ann.y, w: ann.w, h: ann.h };
  }
  if (ann.type === 'rotated') {
    // 旋转框的外接矩形（近似）
    const rad = (ann.angle * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const w = ann.w * cos + ann.h * sin;
    const h = ann.w * sin + ann.h * cos;
    return { x: ann.cx - w / 2, y: ann.cy - h / 2, w, h };
  }
  if (ann.type === 'polygon' && ann.points.length >= 3) {
    const xs = ann.points.map(p => p.x);
    const ys = ann.points.map(p => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return null;
}

/**
 * 执行质量校验
 */
export function runQualityCheck(config: QualityConfig = DEFAULT_QUALITY_CONFIG): QualityReport {
  const issues: QualityIssue[] = [];
  let annotatedImages = 0;
  let totalAnnotations = 0;

  for (const img of images) {
    const anns = annotations[img.name] || [];
    totalAnnotations += anns.length;

    // 1. 未标注图片
    if (config.checkUnannotated && anns.length === 0) {
      issues.push({
        type: 'unannotated',
        image: img.name,
        message: `图片 "${img.name}" 未标注`,
        severity: 'warning',
      });
      continue;
    }

    if (anns.length > 0) annotatedImages++;

    // 获取图片尺寸
    const imgW = img.width || Infinity;
    const imgH = img.height || Infinity;

    // 收集矩形框用于重叠检测
    const rects: { ann: RectAnnotation; idx: number }[] = [];

    for (let i = 0; i < anns.length; i++) {
      const ann = anns[i];

      // 2. 空类别
      if (config.checkEmptyClass && (!ann.className || ann.className.trim() === '')) {
        issues.push({
          type: 'empty_class',
          image: img.name,
          annotationId: ann.id,
          message: `标注 #${ann.id} 类别名为空`,
          severity: 'error',
        });
      }

      // 3. 类别不在类别列表中
      if (ann.className && !classes.includes(ann.className)) {
        issues.push({
          type: 'no_class',
          image: img.name,
          annotationId: ann.id,
          message: `标注 #${ann.id} 类别 "${ann.className}" 不在类别列表中`,
          severity: 'warning',
        });
      }

      // 获取边界框
      const bbox = getBoundingBox(ann);
      if (!bbox) continue;

      // 4. 过小框
      if (config.checkTooSmall && (bbox.w < config.minBoxSize || bbox.h < config.minBoxSize)) {
        issues.push({
          type: 'too_small',
          image: img.name,
          annotationId: ann.id,
          message: `标注 #${ann.id} 框过小 (${bbox.w.toFixed(1)}×${bbox.h.toFixed(1)}px)`,
          severity: 'warning',
        });
      }

      // 5. 越界
      if (config.checkOutOfBounds) {
        if (bbox.x < 0 || bbox.y < 0 || bbox.x + bbox.w > imgW || bbox.y + bbox.h > imgH) {
          issues.push({
            type: 'out_of_bounds',
            image: img.name,
            annotationId: ann.id,
            message: `标注 #${ann.id} 超出图片边界`,
            severity: 'error',
          });
        }
      }

      // 收集矩形框
      if (ann.type === 'rect') {
        rects.push({ ann: ann as RectAnnotation, idx: i });
      }
    }

    // 6. 重叠框检测
    if (config.checkOverlap && rects.length > 1) {
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const iou = rectIoU(rects[i].ann, rects[j].ann);
          if (iou >= config.overlapThreshold) {
            issues.push({
              type: 'overlap',
              image: img.name,
              annotationId: rects[i].ann.id,
              message: `标注 #${rects[i].ann.id} 与 #${rects[j].ann.id} 重叠 (IoU=${(iou * 100).toFixed(1)}%)`,
              severity: 'warning',
            });
          }
        }
      }
    }
  }

  // 统计
  const issueCounts: Record<string, number> = {};
  for (const issue of issues) {
    issueCounts[issue.type] = (issueCounts[issue.type] || 0) + 1;
  }

  const hasErrors = issues.some(i => i.severity === 'error');

  return {
    totalImages: images.length,
    annotatedImages,
    unannotatedImages: images.length - annotatedImages,
    totalAnnotations,
    issues,
    issueCounts,
    passed: !hasErrors,
  };
}
