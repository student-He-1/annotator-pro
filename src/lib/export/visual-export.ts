/** 可视化标注图片导出 — 把带标注的图片渲染为 PNG/JPG */
import type { Annotation, ImageInfo, RectAnnotation, PolygonAnnotation, RotatedAnnotation, KeypointAnnotation } from '../types';
import { getClassColor } from '../state.svelte';
import { getAllSkeletons } from '../skeletons';

export interface VisualExportOptions {
  format: 'png' | 'jpg';
  quality?: number; // JPG 质量 0-1
  lineWidth?: number; // 标注线宽
  fontSize?: number; // 标签字体大小
  showLabels?: boolean; // 是否显示类别标签
  showConfidence?: boolean; // 是否显示置信度
}

export const DEFAULT_VISUAL_OPTIONS: VisualExportOptions = {
  format: 'png',
  quality: 0.92,
  lineWidth: 2,
  fontSize: 14,
  showLabels: true,
  showConfidence: false,
};

/**
 * 渲染带标注的图片到 canvas（异步，等待图片加载）
 */
export async function renderAnnotatedImage(
  imgData: ImageInfo,
  annotations: Annotation[],
  options: VisualExportOptions = DEFAULT_VISUAL_OPTIONS
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = imgData.width;
  canvas.height = imgData.height;
  const ctx = canvas.getContext('2d')!;

  // 等待图片加载（decode 失败时用 onload 兜底）
  const img = new Image();
  img.src = imgData.dataUrl;
  try {
    await img.decode();
  } catch {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Image load failed: ' + imgData.name));
    });
  }
  ctx.drawImage(img, 0, 0);

  // 绘制标注（options 可能是部分覆盖，逐项取默认值）
  const lineWidth = options.lineWidth ?? DEFAULT_VISUAL_OPTIONS.lineWidth;
  const fontSize = options.fontSize ?? DEFAULT_VISUAL_OPTIONS.fontSize;
  const showLabels = options.showLabels !== false;

  for (const ann of annotations) {
    const color = getClassColor(ann.className);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth;

    if (ann.type === 'rect') {
      const rect = ann as RectAnnotation;
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      if (showLabels) {
        drawLabel(ctx, ann.className, rect.x, rect.y, color, fontSize);
      }
    } else if (ann.type === 'rotated') {
      const rot = ann as RotatedAnnotation;
      ctx.save();
      ctx.translate(rot.cx, rot.cy);
      ctx.rotate((rot.angle * Math.PI) / 180);
      ctx.strokeRect(-rot.w / 2, -rot.h / 2, rot.w, rot.h);
      ctx.restore();
      if (showLabels) {
        drawLabel(ctx, ann.className, rot.cx - rot.w / 2, rot.cy - rot.h / 2, color, fontSize);
      }
    } else if (ann.type === 'polygon') {
      const poly = ann as PolygonAnnotation;
      if (poly.points.length >= 3) {
        ctx.beginPath();
        ctx.moveTo(poly.points[0].x, poly.points[0].y);
        for (let i = 1; i < poly.points.length; i++) {
          ctx.lineTo(poly.points[i].x, poly.points[i].y);
        }
        ctx.closePath();
        ctx.stroke();
        if (showLabels) {
          const minX = Math.min(...poly.points.map(p => p.x));
          const minY = Math.min(...poly.points.map(p => p.y));
          drawLabel(ctx, ann.className, minX, minY, color, fontSize);
        }
      }
    } else if (ann.type === 'keypoint') {
      const kp = ann as KeypointAnnotation;
      // 按点数匹配骨架模板（17→COCO人体, 68→人脸, 21→手）
      const tpl = getAllSkeletons().find(t => t.keypoints.length === kp.points.length);
      if (tpl && tpl.skeleton.length > 0) {
        ctx.lineWidth = Math.max(1, lineWidth - 1);
        ctx.beginPath();
        for (const [a, b] of tpl.skeleton) {
          const pa = kp.points[a];
          const pb = kp.points[b];
          if (pa && pb) {
            ctx.moveTo(pa.x, pa.y);
            ctx.lineTo(pb.x, pb.y);
          }
        }
        ctx.stroke();
      }
      // 画点
      for (const pt of kp.points) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, lineWidth * 2, 0, Math.PI * 2);
        ctx.fill();
      }
      if (showLabels && kp.points.length > 0) {
        drawLabel(ctx, ann.className, kp.points[0].x, kp.points[0].y, color, fontSize);
      }
    }
  }

  return canvas;
}

/**
 * 绘制类别标签
 */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  fontSize: number
) {
  ctx.font = `bold ${fontSize}px 'JetBrains Mono', monospace`;
  const metrics = ctx.measureText(text);
  const padding = 4;
  const labelH = fontSize + padding * 2;
  const labelW = metrics.width + padding * 2;

  // 标签背景
  ctx.fillStyle = color;
  ctx.fillRect(x, y - labelH, labelW, labelH);

  // 标签文字
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x + padding, y - labelH + fontSize + padding / 2);
}

/**
 * 导出单张带标注的图片
 */
export async function exportVisualImage(
  imgData: ImageInfo,
  annotations: Annotation[],
  options: VisualExportOptions = DEFAULT_VISUAL_OPTIONS
): Promise<{ filename: string; blob: Blob }> {
  const canvas = await renderAnnotatedImage(imgData, annotations, options);
  const mimeType = options.format === 'jpg' ? 'image/jpeg' : 'image/png';
  const quality = options.format === 'jpg' ? options.quality || 0.92 : undefined;

  const blob = await new Promise<Blob>((resolve) => {
    canvas.toBlob((b) => resolve(b!), mimeType, quality);
  });

  const baseName = imgData.name.replace(/\.[^.]+$/, '');
  const ext = options.format === 'jpg' ? 'jpg' : 'png';
  return { filename: `${baseName}_annotated.${ext}`, blob };
}

/**
 * 导出为 base64 data URL（用于下载）
 */
export async function exportVisualImageDataUrl(
  imgData: ImageInfo,
  annotations: Annotation[],
  options: VisualExportOptions = DEFAULT_VISUAL_OPTIONS
): Promise<{ filename: string; dataUrl: string }> {
  const canvas = await renderAnnotatedImage(imgData, annotations, options);
  const mimeType = options.format === 'jpg' ? 'image/jpeg' : 'image/png';
  const quality = options.format === 'jpg' ? options.quality || 0.92 : undefined;
  const dataUrl = canvas.toDataURL(mimeType, quality);

  const baseName = imgData.name.replace(/\.[^.]+$/, '');
  const ext = options.format === 'jpg' ? 'jpg' : 'png';
  return { filename: `${baseName}_annotated.${ext}`, dataUrl };
}
