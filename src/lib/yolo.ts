/** YOLO 本地预标注 — 基于 ONNX Runtime Web，支持 YOLOv5/v8 */
// 仅类型导入（编译期擦除），运行时通过动态 import 按需加载，避免 28MB 进首屏
import type * as ort from 'onnxruntime-web';
import { getOrt } from './ortRuntime';

export interface Detection {
  x: number;
  y: number;
  w: number;
  h: number;
  className: string;
  confidence: number;
}

export interface YoloConfig {
  confThreshold: number;   // 置信度阈值
  iouThreshold: number;    // NMS IoU 阈值
  inputSize: number;       // 模型输入尺寸（640）
  modelFormat: 'yolov5' | 'yolov8' | 'auto'; // 模型格式
}

export const DEFAULT_YOLO_CONFIG: YoloConfig = {
  confThreshold: 0.25,
  iouThreshold: 0.45,
  inputSize: 640,
  modelFormat: 'auto',
};

let session: ort.InferenceSession | null = null;
let classNames: string[] = [];
let loadedModelName = '';
// 运行时 ort 模块（动态加载，懒初始化）
let ortRuntime: typeof ort | null = null;

/**
 * 加载 ONNX 模型
 */
export async function loadModel(modelFile: File, namesFile?: File): Promise<void> {
  if (!ortRuntime) ortRuntime = await getOrt();
  const arrayBuffer = await modelFile.arrayBuffer();
  session = await ortRuntime.InferenceSession.create(arrayBuffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  loadedModelName = modelFile.name;

  // 加载类别文件
  if (namesFile) {
    const text = await namesFile.text();
    classNames = text.split('\n').map(s => s.trim()).filter(s => s.length > 0);
  } else {
    // 默认 COCO 80 类
    classNames = COCO_CLASSES;
  }
}

/**
 * 检查模型是否已加载
 */
export function isModelLoaded(): boolean {
  return session !== null;
}

export function getModelName(): string {
  return loadedModelName;
}

export function getClassNames(): string[] {
  return classNames;
}

/**
 * 图片预处理：resize + 归一化 + 转 CHW 格式
 */
function preprocess(image: HTMLImageElement, inputSize: number): {
  tensor: ort.Tensor;
  scale: number;
  padX: number;
  padY: number;
} {
  // 创建临时 canvas
  const canvas = document.createElement('canvas');
  canvas.width = inputSize;
  canvas.height = inputSize;
  const ctx = canvas.getContext('2d')!;

  // 计算缩放和 padding（保持宽高比，letterbox）
  const scale = Math.min(inputSize / image.width, inputSize / image.height);
  const newW = Math.round(image.width * scale);
  const newH = Math.round(image.height * scale);
  const padX = (inputSize - newW) / 2;
  const padY = (inputSize - newH) / 2;

  // 绘制灰色背景 + 图片
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, inputSize, inputSize);
  ctx.drawImage(image, padX, padY, newW, newH);

  // 获取 ImageData
  const imageData = ctx.getImageData(0, 0, inputSize, inputSize);
  const data = imageData.data;

  // 转 CHW 格式并归一化到 0-1
  const floatData = new Float32Array(3 * inputSize * inputSize);
  for (let i = 0; i < inputSize * inputSize; i++) {
    floatData[i] = data[i * 4] / 255.0;           // R
    floatData[inputSize * inputSize + i] = data[i * 4 + 1] / 255.0;  // G
    floatData[2 * inputSize * inputSize + i] = data[i * 4 + 2] / 255.0; // B
  }

  const tensor = new ortRuntime!.Tensor('float32', floatData, [1, 3, inputSize, inputSize]);
  return { tensor, scale, padX, padY };
}

/**
 * NMS 非极大值抑制
 */
function nms(boxes: Detection[], iouThreshold: number): Detection[] {
  if (boxes.length === 0) return [];

  // 按置信度降序排序
  boxes.sort((a, b) => b.confidence - a.confidence);

  const result: Detection[] = [];
  const suppressed = new Set<number>();

  for (let i = 0; i < boxes.length; i++) {
    if (suppressed.has(i)) continue;
    result.push(boxes[i]);

    for (let j = i + 1; j < boxes.length; j++) {
      if (suppressed.has(j)) continue;
      const iou = calculateIoU(boxes[i], boxes[j]);
      if (iou > iouThreshold) {
        suppressed.add(j);
      }
    }
  }

  return result;
}

/**
 * 计算两个框的 IoU
 */
function calculateIoU(a: Detection, b: Detection): number {
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

/**
 * 解析 YOLOv5 输出
 * 输出格式: [1, num_anchors, 5+num_classes]
 * 每个 anchor: [x, y, w, h, objectness, class_scores...]
 */
function parseYoloV5Output(
  output: Float32Array,
  numAnchors: number,
  numClasses: number,
  confThreshold: number,
  scale: number,
  padX: number,
  padY: number
): Detection[] {
  const boxes: Detection[] = [];
  const stride = 5 + numClasses;

  for (let i = 0; i < numAnchors; i++) {
    const offset = i * stride;
    const objectness = output[offset + 4];

    if (objectness < confThreshold) continue;

    // 找最大类别分数
    let maxClassScore = 0;
    let maxClassIdx = 0;
    for (let c = 0; c < numClasses; c++) {
      const score = output[offset + 5 + c] * objectness;
      if (score > maxClassScore) {
        maxClassScore = score;
        maxClassIdx = c;
      }
    }

    if (maxClassScore < confThreshold) continue;

    // YOLOv5 输出是 cx, cy, w, h（归一化到 inputSize）
    const cx = output[offset];
    const cy = output[offset + 1];
    const w = output[offset + 2];
    const h = output[offset + 3];

    // 转换回原图坐标（去掉 letterbox padding）
    const x = (cx - w / 2 - padX) / scale;
    const y = (cy - h / 2 - padY) / scale;
    const width = w / scale;
    const height = h / scale;

    boxes.push({
      x, y, w: width, h: height,
      className: classNames[maxClassIdx] || `class_${maxClassIdx}`,
      confidence: maxClassScore,
    });
  }

  return boxes;
}

/**
 * 解析 YOLOv8 输出
 * 输出格式: [1, 4+num_classes, num_anchors]
 * 转置后: [1, num_anchors, 4+num_classes]
 * 每个 anchor: [x, y, w, h, class_scores...]（没有 objectness）
 */
function parseYoloV8Output(
  output: Float32Array,
  numAnchors: number,
  numClasses: number,
  confThreshold: number,
  scale: number,
  padX: number,
  padY: number
): Detection[] {
  const boxes: Detection[] = [];

  for (let i = 0; i < numAnchors; i++) {
    // YOLOv8 输出是 [1, 4+num_classes, num_anchors]
    // 第 i 个 anchor 的数据在 output[0 * (4+num_classes) * numAnchors + c * numAnchors + i]
    let cx = output[i];
    let cy = output[numAnchors + i];
    let w = output[2 * numAnchors + i];
    let h = output[3 * numAnchors + i];

    // 找最大类别分数
    let maxClassScore = 0;
    let maxClassIdx = 0;
    for (let c = 0; c < numClasses; c++) {
      const score = output[(4 + c) * numAnchors + i];
      if (score > maxClassScore) {
        maxClassScore = score;
        maxClassIdx = c;
      }
    }

    if (maxClassScore < confThreshold) continue;

    // 自动检测坐标格式：如果最大值 < 100，说明是归一化坐标（0-1），需要乘以 inputSize
    const maxCoord = Math.max(cx, cy, w, h);
    if (maxCoord < 100) {
      // 归一化坐标，乘以 inputSize 转换为像素坐标
      cx *= 640;
      cy *= 640;
      w *= 640;
      h *= 640;
    }

    // 转换回原图坐标
    const x = (cx - w / 2 - padX) / scale;
    const y = (cy - h / 2 - padY) / scale;
    const width = w / scale;
    const height = h / scale;

    boxes.push({
      x, y, w: width, h: height,
      className: classNames[maxClassIdx] || `class_${maxClassIdx}`,
      confidence: maxClassScore,
    });
  }

  return boxes;
}

/**
 * 自动检测模型格式
 */
function detectModelFormat(outputDims: number[]): 'yolov5' | 'yolov8' {
  // YOLOv5: [1, num_anchors, 5+num_classes] — 3维
  // YOLOv8: [1, 4+num_classes, num_anchors] — 3维
  // 两者都是3维，通过维度比例判断
  // YOLOv5: dims[1] > dims[2]（anchors > classes+5）
  // YOLOv8: dims[1] < dims[2]（classes+4 < anchors）
  if (outputDims[1] > outputDims[2]) {
    return 'yolov5';
  } else {
    return 'yolov8';
  }
}

/**
 * 对图片进行目标检测
 */
export async function detect(
  image: HTMLImageElement,
  config: YoloConfig = DEFAULT_YOLO_CONFIG
): Promise<Detection[]> {
  if (!session) {
    throw new Error('Model not loaded');
  }

  // 预处理
  const { tensor, scale, padX, padY } = preprocess(image, config.inputSize);

  // 推理
  const feeds: Record<string, ort.Tensor> = {};
  const inputName = session.inputNames[0];
  feeds[inputName] = tensor;

  const results = await session.run(feeds);
  const outputName = session.outputNames[0];
  const output = results[outputName];
  const outputData = output.data as Float32Array;
  const outputDims = output.dims;

  // 检测模型格式
  let format = config.modelFormat;
  if (format === 'auto') {
    format = detectModelFormat(outputDims);
  }

  // 解析输出
  let boxes: Detection[];
  if (format === 'yolov5') {
    const numAnchors = outputDims[1];
    const numClasses = outputDims[2] - 5;
    boxes = parseYoloV5Output(outputData, numAnchors, numClasses, config.confThreshold, scale, padX, padY);
  } else {
    const numClasses = outputDims[1] - 4;
    const numAnchors = outputDims[2];
    boxes = parseYoloV8Output(outputData, numAnchors, numClasses, config.confThreshold, scale, padX, padY);
  }

  // NMS
  const result = nms(boxes, config.iouThreshold);

  return result;
}

/**
 * COCO 80 类默认类别
 */
const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
  'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
  'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
  'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator',
  'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
];
