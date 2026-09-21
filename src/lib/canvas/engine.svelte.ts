/** Canvas 2D 渲染引擎 */
import {
  ui, getCurrentAnnotations, getClassColor,
} from '../state.svelte';
import { getSkeleton, getAllSkeletons } from '../skeletons';
import type { Annotation, Point, DragHandle, RectAnnotation, RotatedAnnotation } from '../types';

let ctx: CanvasRenderingContext2D;
let canvas: HTMLCanvasElement;
let container: HTMLElement;

export function initEngine(c: HTMLCanvasElement, ct: HTMLElement) {
  canvas = c;
  ctx = c.getContext('2d')!;
  container = ct;
  resize();
}

export function resize() {
  if (!canvas || !container) return;
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
  render();
}

// ============================================================
// Coordinate Conversion
// ============================================================
export function screenToImage(sx: number, sy: number): Point {
  if (!ui.currentImage) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  return {
    x: (sx - rect.left - ui.panX - canvas.width / 2) / ui.zoom + ui.currentImage.width / 2,
    y: (sy - rect.top - ui.panY - canvas.height / 2) / ui.zoom + ui.currentImage.height / 2,
  };
}

export function imageToScreen(ix: number, iy: number): Point {
  if (!ui.currentImage) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  return {
    x: (ix - ui.currentImage.width / 2) * ui.zoom + ui.panX + canvas.width / 2 + rect.left,
    y: (iy - ui.currentImage.height / 2) * ui.zoom + ui.panY + canvas.height / 2 + rect.top,
  };
}

// ============================================================
// Hit Testing
// ============================================================
export function hitTestAnnotation(imgX: number, imgY: number): Annotation | null {
  const anns = getCurrentAnnotations();
  for (let i = anns.length - 1; i >= 0; i--) {
    if (isPointInAnnotation(imgX, imgY, anns[i])) return anns[i];
  }
  return null;
}

function isPointInAnnotation(px: number, py: number, ann: Annotation): boolean {
  const margin = 5 / ui.zoom;
  switch (ann.type) {
    case 'rect':
      return px >= ann.x - margin && px <= ann.x + ann.w + margin &&
             py >= ann.y - margin && py <= ann.y + ann.h + margin;
    case 'polygon':
      return pointInPolygon(px, py, ann.points);
    case 'rotated': {
      const angle = -ann.angle * Math.PI / 180;
      const dx = px - ann.cx, dy = py - ann.cy;
      const rx = dx * Math.cos(angle) - dy * Math.sin(angle);
      const ry = dx * Math.sin(angle) + dy * Math.cos(angle);
      return Math.abs(rx) <= ann.w / 2 + margin && Math.abs(ry) <= ann.h / 2 + margin;
    }
    case 'keypoint':
      return ann.points.some(p => Math.hypot(px - p.x, py - p.y) < 8 / ui.zoom);
  }
}

function pointInPolygon(px: number, py: number, points: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function hitTestHandle(imgX: number, imgY: number): ui.dragHandle | null {
  if (!ui.selectedAnnotation || ui.selectedAnnotation.type !== 'rect') return null;
  const ann = ui.selectedAnnotation as RectAnnotation;
  const handleSize = 8 / ui.zoom;
  const handles: ui.dragHandle[] = [
    { id: 'tl', x: ann.x, y: ann.y },
    { id: 'tr', x: ann.x + ann.w, y: ann.y },
    { id: 'bl', x: ann.x, y: ann.y + ann.h },
    { id: 'br', x: ann.x + ann.w, y: ann.y + ann.h },
    { id: 'tm', x: ann.x + ann.w / 2, y: ann.y },
    { id: 'bm', x: ann.x + ann.w / 2, y: ann.y + ann.h },
    { id: 'ml', x: ann.x, y: ann.y + ann.h / 2 },
    { id: 'mr', x: ann.x + ann.w, y: ann.y + ann.h / 2 },
  ];
  for (const h of handles) {
    if (Math.abs(imgX - h.x) < handleSize && Math.abs(imgY - h.y) < handleSize) return h;
  }
  return null;
}

// ============================================================
// Polygon Vertex / Edge Hit Testing
// ============================================================

export function hitTestPolygonVertex(imgX: number, imgY: number): number {
  if (!ui.selectedAnnotation || ui.selectedAnnotation.type !== 'polygon') return -1;
  const ann = ui.selectedAnnotation;
  const vertexSize = 6 / ui.zoom;
  for (let i = 0; i < ann.points.length; i++) {
    if (Math.abs(imgX - ann.points[i].x) < vertexSize && Math.abs(imgY - ann.points[i].y) < vertexSize) {
      return i;
    }
  }
  return -1;
}

export function hitTestPolygonEdge(imgX: number, imgY: number): number {
  if (!ui.selectedAnnotation || ui.selectedAnnotation.type !== 'polygon') return -1;
  const ann = ui.selectedAnnotation;
  const threshold = 5 / ui.zoom;
  for (let i = 0; i < ann.points.length; i++) {
    const p1 = ann.points[i];
    const p2 = ann.points[(i + 1) % ann.points.length];
    if (pointToSegmentDistance(imgX, imgY, p1.x, p1.y, p2.x, p2.y) < threshold) return i;
  }
  return -1;
}

function pointToSegmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ============================================================
// Render
// ============================================================
export function render() {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!ui.currentImage) return;

  ctx.save();
  ctx.translate(ui.panX + canvas.width / 2, ui.panY + canvas.height / 2);
  ctx.scale(ui.zoom, ui.zoom);

  const imgW = ui.currentImage.width;
  const imgH = ui.currentImage.height;
  const hw = imgW / 2, hh = imgH / 2;

  ctx.drawImage(ui.currentImage, -hw, -hh, imgW, imgH);

  if (ui.workMode !== 'classification') {
    getCurrentAnnotations().forEach(ann => drawAnnotation(ann, ann === ui.selectedAnnotation));
  }

  if (ui.isDrawing && ui.drawingAnnotation) {
    drawAnnotation(ui.drawingAnnotation, false, true);
  }

  if (ui.currentTool === 'polygon' && ui.polygonPoints.length > 0) {
    drawPolygonPreview();
  }

  // PCS 文本分割结果 hover 预览（黄色虚线高亮）
  if (ui.samPcsPreview && ui.samPcsPreview.points.length >= 3) {
    const pts = ui.samPcsPreview.points;
    ctx.save();
    ctx.strokeStyle = '#fbbf24';
    ctx.fillStyle = 'rgba(251,191,36,0.25)';
    ctx.lineWidth = 2.5 / ui.zoom;
    ctx.setLineDash([8 / ui.zoom, 4 / ui.zoom]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x - hw, pts[0].y - hh);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x - hw, pts[i].y - hh);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

function drawAnnotation(ann: Annotation, isSelected: boolean, isDrawingPreview = false) {
  const color = getClassColor(ann.className);
  const hw = ui.currentImage!.width / 2, hh = ui.currentImage!.height / 2;

  ctx.save();
  ctx.strokeStyle = isSelected ? '#fff' : color;
  ctx.fillStyle = color + '20';
  ctx.lineWidth = isSelected ? 2.5 / ui.zoom : 2 / ui.zoom;
  if (isDrawingPreview) ctx.setLineDash([6 / ui.zoom, 3 / ui.zoom]);

  switch (ann.type) {
    case 'rect': drawRect(ann, hw, hh, isSelected); break;
    case 'polygon': drawPolygon(ann, hw, hh, isSelected); break;
    case 'rotated': drawRotatedBox(ann, hw, hh, isSelected); break;
    case 'keypoint': drawKeypoints(ann, hw, hh); break;
  }

  ctx.restore();

  if (!isDrawingPreview) drawLabel(ann, color, hw, hh);
}

function drawRect(ann: RectAnnotation, hw: number, hh: number, isSelected: boolean) {
  const x = ann.x - hw, y = ann.y - hh;
  ctx.beginPath();
  ctx.rect(x, y, ann.w, ann.h);
  ctx.fill();
  ctx.stroke();
  if (isSelected) drawHandles(x, y, ann.w, ann.h);
}

function drawPolygon(ann: Annotation, hw: number, hh: number, isSelected: boolean) {
  if (!('points' in ann) || ann.points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(ann.points[0].x - hw, ann.points[0].y - hh);
  for (let i = 1; i < ann.points.length; i++) {
    ctx.lineTo(ann.points[i].x - hw, ann.points[i].y - hh);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  if (isSelected) {
    ann.points.forEach(p => {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(p.x - hw, p.y - hh, 4 / ui.zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = getClassColor(ann.className);
      ctx.stroke();
    });
  }
}

function drawRotatedBox(ann: RotatedAnnotation, hw: number, hh: number, isSelected: boolean) {
  const cx = ann.cx - hw, cy = ann.cy - hh;
  const angle = ann.angle * Math.PI / 180;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.rect(-ann.w / 2, -ann.h / 2, ann.w, ann.h);
  ctx.fill();
  ctx.stroke();
  if (isSelected) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(0, 0, 4 / ui.zoom, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  if (isSelected) {
    const corners = getRotatedCorners(ann);
    corners.forEach(c => {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(c.x - hw, c.y - hh, 4 / ui.zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = getClassColor(ann.className);
      ctx.stroke();
    });
  }
}

function getRotatedCorners(ann: RotatedAnnotation): Point[] {
  const angle = ann.angle * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const hw = ann.w / 2, hh = ann.h / 2;
  return [
    { x: ann.cx - hw * cos + hh * sin, y: ann.cy - hw * sin - hh * cos },
    { x: ann.cx + hw * cos + hh * sin, y: ann.cy + hw * sin - hh * cos },
    { x: ann.cx + hw * cos - hh * sin, y: ann.cy + hw * sin + hh * cos },
    { x: ann.cx - hw * cos - hh * sin, y: ann.cy - hw * sin + hh * cos },
  ];
}

function drawKeypoints(ann: Annotation, hw: number, hh: number) {
  if (!('points' in ann)) return;

  // Draw skeleton connections first — 按本标注的点数匹配骨架模板，避免全局 skeletonId 导致连线错乱
  const skel = getAllSkeletons().find(t => t.keypoints.length === ann.points.length) || getSkeleton(ui.skeletonId);
  if (skel.skeleton.length > 0) {
    ctx.save();
    ctx.strokeStyle = getClassColor(ann.className);
    ctx.lineWidth = 2 / ui.zoom;
    ctx.globalAlpha = 0.7;
    skel.skeleton.forEach(([i, j]) => {
      if (i < ann.points.length && j < ann.points.length) {
        ctx.beginPath();
        ctx.moveTo(ann.points[i].x - hw, ann.points[i].y - hh);
        ctx.lineTo(ann.points[j].x - hw, ann.points[j].y - hh);
        ctx.stroke();
      }
    });
    ctx.restore();
  }

  ann.points.forEach((p, i) => {
    const pointColor = skel.colors?.[i] || getClassColor(ann.className);
    ctx.fillStyle = pointColor;
    ctx.beginPath();
    ctx.arc(p.x - hw, p.y - hh, 5 / ui.zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5 / ui.zoom;
    ctx.stroke();
    ctx.lineWidth = 2 / ui.zoom;
    ctx.fillStyle = '#fff';
    ctx.font = `${10 / ui.zoom}px 'JetBrains Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), p.x - hw, p.y - hh);
  });
}

function drawPolygonPreview() {
  const hw = ui.currentImage!.width / 2, hh = ui.currentImage!.height / 2;
  const color = getClassColor(ui.polygonPoints[0]?.className || 'default');
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color + '30';
  ctx.lineWidth = 2 / ui.zoom;
  ctx.setLineDash([6 / ui.zoom, 3 / ui.zoom]);
  if (ui.polygonPoints.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(ui.polygonPoints[0].x - hw, ui.polygonPoints[0].y - hh);
    for (let i = 1; i < ui.polygonPoints.length; i++) {
      ctx.lineTo(ui.polygonPoints[i].x - hw, ui.polygonPoints[i].y - hh);
    }
    ctx.stroke();
  }
  ui.polygonPoints.forEach(p => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x - hw, p.y - hh, 3 / ui.zoom, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

function drawHandles(x: number, y: number, w: number, h: number) {
  const handles = [
    { x, y }, { x: x + w, y }, { x, y: y + h }, { x: x + w, y: y + h },
    { x: x + w / 2, y }, { x: x + w / 2, y: y + h },
    { x, y: y + h / 2 }, { x: x + w, y: y + h / 2 },
  ];
  const color = getClassColor(ui.selectedAnnotation!.className);
  handles.forEach(hh => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(hh.x - 3 / ui.zoom, hh.y - 3 / ui.zoom, 6 / ui.zoom, 6 / ui.zoom);
    ctx.strokeStyle = color;
    ctx.strokeRect(hh.x - 3 / ui.zoom, hh.y - 3 / ui.zoom, 6 / ui.zoom, 6 / ui.zoom);
  });
}

function drawLabel(ann: Annotation, color: string, hw: number, hh: number) {
  let labelX = 0, labelY = 0;
  switch (ann.type) {
    case 'rect':
      labelX = ann.x - hw; labelY = ann.y - hh - 4 / ui.zoom; break;
    case 'polygon':
      if ('points' in ann && ann.points.length > 0) {
        const minY = Math.min(...ann.points.map(p => p.y));
        const minX = ann.points.reduce((a, b) => a.x < b.x ? a : b).x;
        labelX = minX - hw; labelY = minY - hh - 4 / ui.zoom;
      }
      break;
    case 'rotated':
      labelX = ann.cx - hw - ann.w / 2; labelY = ann.cy - hh - ann.h / 2 - 4 / ui.zoom; break;
    case 'keypoint':
      if ('points' in ann && ann.points.length > 0) {
        const minY = Math.min(...ann.points.map(p => p.y));
        labelX = ann.points[0].x - hw; labelY = minY - hh - 10 / ui.zoom;
      }
      break;
  }

  ctx.save();
  ctx.font = `${12 / ui.zoom}px 'JetBrains Mono', monospace`;
  const text = ann.className;
  const metrics = ctx.measureText(text);
  const pw = metrics.width + 6 / ui.zoom;
  const ph = 16 / ui.zoom;
  ctx.fillStyle = color;
  ctx.fillRect(labelX, labelY, pw, ph);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, labelX + 3 / ui.zoom, labelY + ph / 2);
  ctx.restore();
}

export function resizeRectAnnotation(ann: RectAnnotation, handleId: string, dx: number, dy: number) {
  switch (handleId) {
    case 'tl': ann.x += dx; ann.y += dy; ann.w -= dx; ann.h -= dy; break;
    case 'tr': ann.y += dy; ann.w += dx; ann.h -= dy; break;
    case 'bl': ann.x += dx; ann.w -= dx; ann.h += dy; break;
    case 'br': ann.w += dx; ann.h += dy; break;
    case 'tm': ann.y += dy; ann.h -= dy; break;
    case 'bm': ann.h += dy; break;
    case 'ml': ann.x += dx; ann.w -= dx; break;
    case 'mr': ann.w += dx; break;
  }
  if (ann.w < 5) ann.w = 5;
  if (ann.h < 5) ann.h = 5;
}

export function fitToScreen() {
  if (!ui.currentImage || !container) return;
  const cw = container.clientWidth, ch = container.clientHeight;
  const iw = ui.currentImage.width, ih = ui.currentImage.height;
  const scale = Math.min(cw / iw, ch / ih, 1) * 0.9;
  ui.zoom = scale;
  ui.panX = 0;
  ui.panY = 0;
  return scale;
}
