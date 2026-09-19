// LabelMe JSON 导入解析
import type { Annotation } from '../types';

export interface LabelMeShape {
  label: string;
  points: number[][];
  shape_type: string;
  group_id: number | null;
  description: string;
  flags: Record<string, any>;
}

export interface LabelMeData {
  version: string;
  flags: Record<string, any>;
  shapes: LabelMeShape[];
  imagePath: string;
  imageData: string | null;
  imageHeight: number;
  imageWidth: number;
}

let nextId = 0;
function genId(): number {
  return nextId++;
}

/**
 * 解析 LabelMe JSON 为标注数组
 * @param jsonText LabelMe JSON 字符串
 * @param startId 起始 ID（用于避免与现有标注冲突）
 */
export function parseLabelMe(jsonText: string, startId: number = 0): Annotation[] {
  nextId = startId;
  const data: LabelMeData = JSON.parse(jsonText);
  const annotations: Annotation[] = [];

  for (const shape of data.shapes) {
    if (!shape.points || shape.points.length === 0) continue;
    const className = shape.label || 'unknown';

    switch (shape.shape_type) {
      case 'rectangle': {
        if (shape.points.length < 2) break;
        const [p1, p2] = shape.points;
        const x = Math.min(p1[0], p2[0]);
        const y = Math.min(p1[1], p2[1]);
        const w = Math.abs(p2[0] - p1[0]);
        const h = Math.abs(p2[1] - p1[1]);
        annotations.push({
          id: genId(),
          type: 'rect',
          className,
          x, y, w, h,
        });
        break;
      }
      case 'polygon': {
        if (shape.points.length < 3) break;
        annotations.push({
          id: genId(),
          type: 'polygon',
          className,
          points: shape.points.map(p => ({ x: p[0], y: p[1] })),
        });
        break;
      }
      case 'point': {
        annotations.push({
          id: genId(),
          type: 'keypoint',
          className,
          points: shape.points.map(p => ({ x: p[0], y: p[1] })),
        });
        break;
      }
      case 'linestrip':
      case 'line': {
        if (shape.points.length < 2) break;
        annotations.push({
          id: genId(),
          type: 'keypoint',
          className,
          points: shape.points.map(p => ({ x: p[0], y: p[1] })),
        });
        break;
      }
      case 'circle': {
        // 圆转矩形框（外接框）
        if (shape.points.length < 2) break;
        const [center, edge] = shape.points;
        const radius = Math.sqrt(Math.pow(edge[0] - center[0], 2) + Math.pow(edge[1] - center[1], 2));
        annotations.push({
          id: genId(),
          type: 'rect',
          className,
          x: center[0] - radius,
          y: center[1] - radius,
          w: radius * 2,
          h: radius * 2,
        });
        break;
      }
      default:
        // 未知类型，尝试作为多边形处理
        if (shape.points.length >= 3) {
          annotations.push({
            id: genId(),
            type: 'polygon',
            className,
            points: shape.points.map(p => ({ x: p[0], y: p[1] })),
          });
        }
        break;
    }
  }

  return annotations;
}

/**
 * 从 LabelMe JSON 中提取图片尺寸
 */
export function getLabelMeImageSize(jsonText: string): { width: number; height: number; imagePath: string } | null {
  try {
    const data: LabelMeData = JSON.parse(jsonText);
    return {
      width: data.imageWidth || 0,
      height: data.imageHeight || 0,
      imagePath: data.imagePath || '',
    };
  } catch {
    return null;
  }
}
