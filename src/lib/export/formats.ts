/** 导出格式模块 */
import type { Annotation, ImageInfo, ExportFormat } from '../types';
import { keypointExportName, skeletonFor } from '../skeletons';
import { images, annotations, classes, ui } from '../state.svelte';

// ============================================================
// 关键点在各个格式里的待遇不一样，先集中说明（改之前请看这段）
// ============================================================
//  keypoint 的 className 在语义上其实是「骨架类型」（person/face/hand），不是目标类别。
//  · COCO     ：category_id 是规范必需字段，而且该 category 必须自带 keypoints/skeleton，
//               否则训练脚本读不出关键点。所以用 keypointExportName() 生成独立的骨架类别。
//  · LabelMe  ：每个 shape 必须有 label，同样用骨架名，不能空着。
//  · VOC/YOLO ：这两个格式**没有**关键点概念，关键点会被丢掉 —— 导出前要明确告诉用户。
//  · CreateML ：同上，只支持矩形框。
//  · PNG/JPG  ：可视化图，只画骨架和点，不画类别角标。
//
//  这个格式矩阵由 formatDropsKeypoints() / formatLabel() 对外提供，供导出前提示用。

/** 该格式会不会丢掉关键点（确认没有关键点概念的那几个） */
export function formatDropsKeypoints(format: ExportFormat): boolean {
  return format === 'voc' || format === 'yolo' || format === 'createml';
}

/** 导出格式的中文名，用于提示文案 */
export function formatLabel(format: ExportFormat): string {
  switch (format) {
    case 'voc': return 'PASCAL VOC XML';
    case 'yolo': return 'YOLO TXT';
    case 'coco': return 'COCO JSON';
    case 'coco_merged': return 'COCO JSON（合并）';
    case 'createml': return 'CreateML JSON';
    case 'labelme': return 'LabelMe JSON';
    case 'png': return 'PNG 可视化图片';
    case 'jpg': return 'JPG 可视化图片';
    case 'unet_mask': return 'U-Net Mask';
    default: return String(format);
  }
}

/** 取文件名（不含目录、不含扩展名）。
 *
 *  图片的 `name` 可能是相对路径（文件夹导入会保留 `photos/beach.jpg`）。
 *  导出时如果原样当文件名用，磁盘上就会凭空多出一个 `photos/` 子目录 ——
 *  Rust 侧建父目录是为了不让写入失败，但用户看到的是一个莫名其妙的文件夹。
 *  所以导出一律只用 basename。
 */
export function baseNameOf(name: string): string {
  const file = name.split(/[\\/]/).pop() || name;
  return file.replace(/\.[^.]+$/, '');
}

export function getExportData(
  imageName: string,
  format: ExportFormat,
): { filename: string; content: string; mimeType: string } | null {
  const imgData = images.find(i => i.name === imageName);
  if (!imgData) return null;
  const anns = annotations[imageName] || [];
  if (anns.length === 0) return null;

  const baseName = baseNameOf(imageName);

  switch (format) {
    case 'voc': return exportVOC(imgData, anns, baseName);
    case 'yolo': return exportYOLO(imgData, anns, baseName);
    case 'coco': return exportCOCO(imgData, anns, baseName);
    case 'createml': return exportCreateML(imgData, anns, baseName);
    case 'labelme': return exportLabelMe(imgData, anns, baseName);
    default: return null;
  }
}

function exportVOC(imgData: ImageInfo, anns: Annotation[], baseName: string) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<annotation>\n';
  xml += `  <folder>images</folder>\n  <filename>${imgData.name}</filename>\n`;
  xml += `  <path>./${imgData.name}</path>\n  <source><database>Unknown</database></source>\n`;
  xml += `  <size>\n    <width>${imgData.width}</width>\n    <height>${imgData.height}</height>\n    <depth>3</depth>\n  </size>\n  <segmented>0</segmented>\n`;
  anns.forEach(ann => {
    if (ann.type === 'rect') {
      xml += `  <object>\n    <name>${ann.className}</name>\n    <pose>Unspecified</pose>\n`;
      xml += `    <truncated>0</truncated>\n    <difficult>0</difficult>\n    <bndbox>\n`;
      xml += `      <xmin>${Math.round(ann.x)}</xmin>\n      <ymin>${Math.round(ann.y)}</ymin>\n`;
      xml += `      <xmax>${Math.round(ann.x + ann.w)}</xmax>\n      <ymax>${Math.round(ann.y + ann.h)}</ymax>\n`;
      xml += `    </bndbox>\n  </object>\n`;
    } else if (ann.type === 'rotated') {
      xml += `  <object>\n    <name>${ann.className}</name>\n    <pose>Unspecified</pose>\n`;
      xml += `    <truncated>0</truncated>\n    <difficult>0</difficult>\n    <rotated_box>\n`;
      xml += `      <cx>${Math.round(ann.cx)}</cx>\n      <cy>${Math.round(ann.cy)}</cy>\n`;
      xml += `      <w>${Math.round(ann.w)}</w>\n      <h>${Math.round(ann.h)}</h>\n`;
      xml += `      <angle>${ann.angle.toFixed(2)}</angle>\n`;
      xml += `    </rotated_box>\n  </object>\n`;
    }
  });
  xml += '</annotation>';
  return { filename: baseName + '.xml', content: xml, mimeType: 'text/xml' };
}

function exportYOLO(imgData: ImageInfo, anns: Annotation[], baseName: string) {
  let txt = '';
  anns.forEach(ann => {
    const classIdx = classes.indexOf(ann.className);
    if (classIdx < 0) return;
    if (ann.type === 'rect') {
      txt += `${classIdx} ${((ann.x + ann.w / 2) / imgData.width).toFixed(6)} ${((ann.y + ann.h / 2) / imgData.height).toFixed(6)} ${(ann.w / imgData.width).toFixed(6)} ${(ann.h / imgData.height).toFixed(6)}\n`;
    } else if (ann.type === 'rotated') {
      // OBB format: class x1 y1 x2 y2 x3 y3 x4 y4 (normalized)
      const rAngle = ann.angle * Math.PI / 180;
      const rCos = Math.cos(rAngle), rSin = Math.sin(rAngle);
      const rHw = ann.w / 2, rHh = ann.h / 2;
      const corners = [
        { x: ann.cx - rHw * rCos + rHh * rSin, y: ann.cy - rHw * rSin - rHh * rCos },
        { x: ann.cx + rHw * rCos + rHh * rSin, y: ann.cy + rHw * rSin - rHh * rCos },
        { x: ann.cx + rHw * rCos - rHh * rSin, y: ann.cy + rHw * rSin + rHh * rCos },
        { x: ann.cx - rHw * rCos - rHh * rSin, y: ann.cy - rHw * rSin + rHh * rCos },
      ];
      txt += `${classIdx} ` + corners.map(p => `${(p.x / imgData.width).toFixed(6)} ${(p.y / imgData.height).toFixed(6)}`).join(' ') + '\n';
    } else if (ann.type === 'polygon') {
      txt += `${classIdx} ` + ann.points.map(p => `${(p.x / imgData.width).toFixed(6)} ${(p.y / imgData.height).toFixed(6)}`).join(' ') + '\n';
    }
  });
  return { filename: baseName + '.txt', content: txt, mimeType: 'text/plain' };
}

/**
 * COCO 的类别表 = 检测类别 + 关键点骨架类别。
 *
 * 关键点的 category 不能沿用 className（那其实是「骨架类型」）。
 * 骨架类别必须带上 keypoints / skeleton 定义，否则训练脚本读不出关键点。
 * 如果骨架的导出名（person / face / hand）刚好和某个检测类同名，复用那个 id ——
 * 这也是 COCO 的惯例（person 既是检测类，也是关键点类）。
 */
function buildCocoCategories(annsList: Annotation[][]): any[] {
  const cats: any[] = classes.map((c, i) => ({ id: i + 1, name: c, supercategory: 'none' }));
  for (const anns of annsList) {
    for (const ann of anns) {
      if (ann.type !== 'keypoint') continue;
      const tpl = skeletonFor(ann.skeletonId, ann.points.length);
      if (!tpl) continue;
      const name = keypointExportName(ann.points.length, ann.skeletonId);
      let cat = cats.find(c => c.name === name);
      if (!cat) {
        cat = { id: cats.length + 1, name, supercategory: 'none' };
        cats.push(cat);
      }
      // 同名的骨架类别只需要定义一次
      if (!cat.keypoints) {
        cat.keypoints = tpl.keypoints;
        cat.skeleton = tpl.skeleton.map(e => [e[0] + 1, e[1] + 1]);
      }
    }
  }
  return cats;
}

/** 一条标注在 COCO 里对应的 category id */
function cocoCatId(ann: Annotation, cats: any[]): number {
  const name = ann.type === 'keypoint'
    ? keypointExportName(ann.points.length, ann.skeletonId)
    : ann.className;
  const idx = cats.findIndex(c => c.name === name);
  return idx >= 0 ? idx + 1 : 1;
}

function exportCOCO(imgData: ImageInfo, anns: Annotation[], baseName: string) {
  const imageId = images.findIndex(i => i.name === imgData.name) + 1;
  const cats = buildCocoCategories([anns]);
  const coco = {
    images: [{ id: imageId, file_name: imgData.name, width: imgData.width, height: imgData.height }],
    annotations: [] as any[],
    categories: cats,
  };
  anns.forEach((ann, i) => {
    const ca: any = { id: i + 1, image_id: imageId, category_id: cocoCatId(ann, cats) };
    switch (ann.type) {
      case 'rect':
        ca.bbox = [ann.x, ann.y, ann.w, ann.h];
        ca.area = ann.w * ann.h;
        ca.segmentation = [[ann.x, ann.y, ann.x + ann.w, ann.y, ann.x + ann.w, ann.y + ann.h, ann.x, ann.y + ann.h]];
        break;
      case 'polygon': {
        const xs = ann.points.map(p => p.x), ys = ann.points.map(p => p.y);
        ca.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
        ca.area = polygonArea(ann.points);
        ca.segmentation = [ann.points.flatMap(p => [p.x, p.y])];
        break;
      }
      case 'rotated': {
        ca.bbox = [ann.cx - ann.w / 2, ann.cy - ann.h / 2, ann.w, ann.h];
        ca.area = ann.w * ann.h;
        ca.angle = ann.angle;
        const rAngle = ann.angle * Math.PI / 180;
        const rCos = Math.cos(rAngle), rSin = Math.sin(rAngle);
        const rHw = ann.w / 2, rHh = ann.h / 2;
        ca.segmentation = [[
          ann.cx - rHw * rCos + rHh * rSin, ann.cy - rHw * rSin - rHh * rCos,
          ann.cx + rHw * rCos + rHh * rSin, ann.cy + rHw * rSin - rHh * rCos,
          ann.cx + rHw * rCos - rHh * rSin, ann.cy + rHw * rSin + rHh * rCos,
          ann.cx - rHw * rCos - rHh * rSin, ann.cy - rHw * rSin + rHh * rCos,
        ]];
        break;
      }
      case 'keypoint': {
        const xs = ann.points.map(p => p.x), ys = ann.points.map(p => p.y);
        ca.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs)-Math.min(...xs), Math.max(...ys)-Math.min(...ys)];
        ca.area = ca.bbox[2] * ca.bbox[3];
        ca.keypoints = ann.points.flatMap(p => [p.x, p.y, 2]);
        ca.num_keypoints = ann.points.length;
        break;
      }
    }
    coco.annotations.push(ca);
  });
  return { filename: baseName + '.json', content: JSON.stringify(coco, null, 2), mimeType: 'application/json' };
}

function exportCreateML(imgData: ImageInfo, anns: Annotation[], baseName: string) {
  const list = anns.filter(a => a.type === 'rect').map(ann => ({
    label: ann.className,
    coordinates: { x: Math.round(ann.x), y: Math.round(ann.y), width: Math.round(ann.w), height: Math.round(ann.h) },
  }));
  const data = [{ image: imgData.name, annotations: list }];
  return { filename: baseName + '_createml.json', content: JSON.stringify(data, null, 2), mimeType: 'application/json' };
}

export function getMergedCOCO(): string {
  const cats = buildCocoCategories(images.map(img => annotations[img.name] || []));
  const coco = {
    images: [] as any[],
    annotations: [] as any[],
    categories: cats,
  };
  let annId = 1;
  images.forEach((img, imgIdx) => {
    const anns = annotations[img.name] || [];
    if (anns.length === 0) return;
    coco.images.push({ id: imgIdx + 1, file_name: img.name, width: img.width, height: img.height });
    anns.forEach(ann => {
      const ca: any = { id: annId++, image_id: imgIdx + 1, category_id: cocoCatId(ann, cats) };
      switch (ann.type) {
        case 'rect':
          ca.bbox = [ann.x, ann.y, ann.w, ann.h];
          ca.area = ann.w * ann.h;
          ca.segmentation = [[ann.x, ann.y, ann.x + ann.w, ann.y, ann.x + ann.w, ann.y + ann.h, ann.x, ann.y + ann.h]];
          break;
        case 'polygon': {
          const xs = ann.points.map(p => p.x), ys = ann.points.map(p => p.y);
          ca.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
          ca.area = polygonArea(ann.points);
          ca.segmentation = [ann.points.flatMap(p => [p.x, p.y])];
          break;
        }
        case 'rotated': {
          ca.bbox = [ann.cx - ann.w / 2, ann.cy - ann.h / 2, ann.w, ann.h];
          ca.area = ann.w * ann.h;
          ca.angle = ann.angle;
          const rAngle = ann.angle * Math.PI / 180;
          const rCos = Math.cos(rAngle), rSin = Math.sin(rAngle);
          const rHw = ann.w / 2, rHh = ann.h / 2;
          ca.segmentation = [[
            ann.cx - rHw * rCos + rHh * rSin, ann.cy - rHw * rSin - rHh * rCos,
            ann.cx + rHw * rCos + rHh * rSin, ann.cy + rHw * rSin - rHh * rCos,
            ann.cx + rHw * rCos - rHh * rSin, ann.cy + rHw * rSin + rHh * rCos,
            ann.cx - rHw * rCos - rHh * rSin, ann.cy - rHw * rSin + rHh * rCos,
          ]];
          break;
        }
        case 'keypoint': {
          const xs = ann.points.map(p => p.x), ys = ann.points.map(p => p.y);
          ca.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs)-Math.min(...xs), Math.max(...ys)-Math.min(...ys)];
          ca.area = ca.bbox[2] * ca.bbox[3];
          ca.keypoints = ann.points.flatMap(p => [p.x, p.y, 2]);
          ca.num_keypoints = ann.points.length;
          break;
        }
      }
      coco.annotations.push(ca);
    });
  });
  return JSON.stringify(coco, null, 2);
}

// LabelMe JSON 导出
function exportLabelMe(imgData: ImageInfo, anns: Annotation[], baseName: string) {
  const shapes: any[] = [];
  for (const ann of anns) {
    let shapeType = '';
    let points: number[][] = [];
    switch (ann.type) {
      case 'rect':
        shapeType = 'rectangle';
        points = [[ann.x, ann.y], [ann.x + ann.w, ann.y + ann.h]];
        break;
      case 'polygon':
        shapeType = 'polygon';
        points = ann.points.map(p => [p.x, p.y]);
        break;
      case 'rotated': {
        // 旋转框转多边形（4个角点）
        shapeType = 'polygon';
        const rAngle = ann.angle * Math.PI / 180;
        const rCos = Math.cos(rAngle), rSin = Math.sin(rAngle);
        const cx = ann.cx, cy = ann.cy, w = ann.w / 2, h = ann.h / 2;
        const corners = [
          { x: -w, y: -h }, { x: w, y: -h }, { x: w, y: h }, { x: -w, y: h }
        ];
        points = corners.map(c => [cx + c.x * rCos - c.y * rSin, cy + c.x * rSin + c.y * rCos]);
        break;
      }
      case 'keypoint':
        if (ann.points.length === 1) {
          shapeType = 'point';
          points = [[ann.points[0].x, ann.points[0].y]];
        } else {
          shapeType = 'linestrip';
          points = ann.points.map(p => [p.x, p.y]);
        }
        break;
      default:
        continue;
    }
    shapes.push({
      // 关键点用骨架名（person/face/hand），不是当前激活的类别
      label: ann.type === 'keypoint' ? keypointExportName(ann.points.length, ann.skeletonId) : ann.className,
      points,
      group_id: null,
      description: '',
      shape_type: shapeType,
      flags: {},
    });
  }
  const labelme = {
    version: '5.0.1',
    flags: {},
    shapes,
    imagePath: imgData.name,
    imageData: null,
    imageHeight: imgData.height,
    imageWidth: imgData.width,
  };
  return { filename: baseName + '.json', content: JSON.stringify(labelme, null, 2), mimeType: 'application/json' };
}

export function polygonArea(points: { x: number; y: number }[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  return Math.abs(area) / 2;
}

export function downloadFile(filename: string, content: string, mimeType: string) {
  // dataURL（PNG/JPG 可视化导出）直接作为 href，避免被当文本写入 Blob
  if (content.startsWith('data:')) {
    const a = document.createElement('a');
    a.href = content;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function getClassificationCSVContent(): string {
  const rows = ['filename,label'];
  for (const img of images) {
    const labels = ui.imageLabels[img.name] || [];
    for (const label of labels) {
      rows.push('"' + img.name + '","' + label + '"');
    }
  }
  return rows.join('\n');
}

export function exportClassificationCSV() {
  const content = getClassificationCSVContent();
  downloadFile('classification_labels.csv', content, 'text/csv');
}


/** U-Net Mask 导出：单通道灰度 PNG，像素值=类别索引（0=背景） */
export async function exportUnetMask(imgData: ImageInfo, anns: Annotation[]): Promise<{ filename: string; dataUrl: string }> {
  const canvas = document.createElement('canvas');
  canvas.width = imgData.width;
  canvas.height = imgData.height;
  const ctx = canvas.getContext('2d')!;
  // 黑底（0=背景）
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const ann of anns) {
    const catIdx = classes.indexOf(ann.className) + 1;  // 1-based
    if (catIdx <= 0) continue;
    const gray = String(catIdx);
    ctx.fillStyle = 'rgb(' + gray + ',' + gray + ',' + gray + ')';


    if (ann.type === 'rect') {
      ctx.fillRect(ann.x, ann.y, ann.w, ann.h);
    } else if (ann.type === 'polygon') {
      if (ann.points.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(ann.points[0].x, ann.points[0].y);
      for (let i = 1; i < ann.points.length; i++) ctx.lineTo(ann.points[i].x, ann.points[i].y);
      ctx.closePath();
      ctx.fill();
    } else if (ann.type === 'rotated') {
      ctx.save();
      ctx.translate(ann.cx, ann.cy);
      ctx.rotate((ann.angle * Math.PI) / 180);
      ctx.fillRect(-ann.w / 2, -ann.h / 2, ann.w, ann.h);
      ctx.restore();
    }
    // keypoint 无区域，跳过
  }

  const baseName = imgData.name.replace(/\.[^.]+$/, '');
  return { filename: baseName + '.png', dataUrl: canvas.toDataURL('image/png') };
}
