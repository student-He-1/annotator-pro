/** SAM 一键分割 — 基于 ONNX Runtime Web，支持 SAM/MobileSAM
 *  模型格式：标准双文件 ONNX 导出
 *  - image_encoder.onnx: 输入 [1,3,1024,1024] → 输出 [1,256,64,64] image embedding
 *  - prompt_encoder_mask_decoder.onnx: 输入 embedding+prompt → 输出 mask+iou+low_res_mask
 *  参考：segment-anything 官方 onnx 导出格式
 */
import type * as ort from 'onnxruntime-web';
import { extractContour, simplifyPolygon } from './magicwand';

export interface SamPoint {
  x: number;  // 原图坐标
  y: number;
  label: 1 | 0;  // 1=正点(前景), 0=负点(背景)
}

export interface SamBox {
  x: number; y: number; w: number; h: number;  // 原图坐标
}

export interface SamResult {
  mask: Uint8Array;       // 二值 mask，长度=width*height
  width: number;
  height: number;
  iou: number;            // 模型预测的 mask 质量分
  polygon: { x: number; y: number }[];  // mask 轮廓多边形（已简化）
}

export interface SamConfig {
  encoderInputSize: number;  // encoder 输入尺寸，默认 1024
  maskThreshold: number;      // mask 二值化阈值，默认 0.0
  simplifyTolerance: number;  // 多边形简化精度，默认 1.0
  multiMask: boolean;         // 是否输出3个候选mask（取最优），默认 false
}

export const DEFAULT_SAM_CONFIG: SamConfig = {
  encoderInputSize: 1024,
  maskThreshold: 0.0,
  simplifyTolerance: 1.0,
  multiMask: false,
};

// ImageNet 归一化参数（SAM 标准预处理）
const IMAGENET_MEAN = [123.675, 116.28, 103.53];
const IMAGENET_STD = [58.395, 57.12, 57.375];

let encoderSession: ort.InferenceSession | null = null;
let decoderSession: ort.InferenceSession | null = null;
let loadedEncoderName = '';
let loadedDecoderName = '';
let ortRuntime: typeof ort | null = null;
let ortPromise: Promise<typeof ort> | null = null;

// 缓存的 image embedding（同一图片多次分割只编码一次）
let cachedEmbedding: ort.Tensor | null = null;
let cachedImageKey = '';

async function getOrt(): Promise<typeof ort> {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web').then((ort) => {
      // 配置 WASM 文件路径
      ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
      return ort;
    });
  }
  return ortPromise;
}

/**
 * 加载 SAM 模型（encoder + decoder 两个 ONNX 文件）
 */
export async function loadModel(encoderFile: File, decoderFile: File): Promise<void> {
  if (!ortRuntime) ortRuntime = await getOrt();

  const encBuf = await encoderFile.arrayBuffer();
  encoderSession = await ortRuntime.InferenceSession.create(encBuf, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  loadedEncoderName = encoderFile.name;

  const decBuf = await decoderFile.arrayBuffer();
  decoderSession = await ortRuntime.InferenceSession.create(decBuf, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  loadedDecoderName = decoderFile.name;

  // 清空缓存
  cachedEmbedding = null;
  cachedImageKey = '';
}

export function isModelLoaded(): boolean {
  return encoderSession !== null && decoderSession !== null;
}

export function getModelName(): string {
  return loadedEncoderName ? `${loadedEncoderName} + ${loadedDecoderName}` : '';
}

/**
 * 图片预处理：resize 到最长边 1024（保持比例+padding）+ ImageNet 归一化 + CHW
 */
function preprocessImage(
  image: HTMLImageElement,
  inputSize: number
): { tensor: ort.Tensor; scale: number; padX: number; padY: number; newW: number; newH: number } {
  const canvas = document.createElement('canvas');
  canvas.width = inputSize;
  canvas.height = inputSize;
  const ctx = canvas.getContext('2d')!;

  // 最长边缩放到 inputSize，保持比例
  const scale = Math.min(inputSize / image.width, inputSize / image.height);
  const newW = Math.round(image.width * scale);
  const newH = Math.round(image.height * scale);
  const padX = Math.floor((inputSize - newW) / 2);
  const padY = Math.floor((inputSize - newH) / 2);

  // 灰色背景 + 图片
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, inputSize, inputSize);
  ctx.drawImage(image, padX, padY, newW, newH);

  const imageData = ctx.getImageData(0, 0, inputSize, inputSize);
  const data = imageData.data;

  // CHW + ImageNet 归一化
  const floatData = new Float32Array(3 * inputSize * inputSize);
  for (let i = 0; i < inputSize * inputSize; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    floatData[i] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    floatData[inputSize * inputSize + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    floatData[2 * inputSize * inputSize + i] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }

  const tensor = new ortRuntime!.Tensor('float32', floatData, [1, 3, inputSize, inputSize]);
  return { tensor, scale, padX, padY, newW, newH };
}

/**
 * 运行 image encoder，缓存 embedding
 */
async function encodeImage(
  image: HTMLImageElement,
  config: SamConfig
): Promise<{ embedding: ort.Tensor; scale: number; padX: number; padY: number }> {
  const key = `${image.src}_${image.width}x${image.height}_${config.encoderInputSize}`;
  if (cachedEmbedding && cachedImageKey === key) {
    // 需要重新获取 scale/padX/padY
    const { scale, padX, padY } = preprocessImage(image, config.encoderInputSize);
    return { embedding: cachedEmbedding, scale, padX, padY };
  }

  if (!encoderSession) throw new Error('SAM encoder not loaded');

  const { tensor, scale, padX, padY } = preprocessImage(image, config.encoderInputSize);
  const inputName = encoderSession.inputNames[0];
  const feeds: Record<string, ort.Tensor> = { [inputName]: tensor };
  const results = await encoderSession.run(feeds);
  const outputName = encoderSession.outputNames[0];

  cachedEmbedding = results[outputName];
  cachedImageKey = key;

  return { embedding: cachedEmbedding, scale, padX, padY };
}

/**
 * 将原图坐标转换为 encoder 输入空间坐标（0-1024）
 */
function toEncoderCoords(
  x: number, y: number,
  scale: number, padX: number, padY: number
): [number, number] {
  return [x * scale + padX, y * scale + padY];
}

/**
 * 运行 prompt decoder，生成 mask
 */
async function runDecoder(
  embedding: ort.Tensor,
  points: SamPoint[],
  box: SamBox | null,
  origWidth: number,
  origHeight: number,
  scale: number,
  padX: number,
  padY: number,
  config: SamConfig
): Promise<{ mask: Float32Array; iou: number; width: number; height: number }> {
  if (!decoderSession) throw new Error('SAM decoder not loaded');

  // 构造 prompt 坐标和标签
  const coords: number[] = [];
  const labels: number[] = [];

  // 框 prompt：左上点(label=2) + 右下点(label=3)
  if (box) {
    const [x1, y1] = toEncoderCoords(box.x, box.y, scale, padX, padY);
    const [x2, y2] = toEncoderCoords(box.x + box.w, box.y + box.h, scale, padX, padY);
    coords.push(x1, y1, x2, y2);
    labels.push(2, 3);
  }

  // 点 prompt
  for (const p of points) {
    const [ex, ey] = toEncoderCoords(p.x, p.y, scale, padX, padY);
    coords.push(ex, ey);
    labels.push(p.label);
  }

  // 至少需要一个 prompt
  if (coords.length === 0) {
    throw new Error('No prompt provided (need points or box)');
  }

  const numPoints = labels.length;
  const pointCoordsTensor = new ortRuntime!.Tensor('float32', Float32Array.from(coords), [1, numPoints, 2]);
  const pointLabelsTensor = new ortRuntime!.Tensor('float32', Float32Array.from(labels), [1, numPoints]);

  // mask_input：首次用全零低分辨率 mask
  const maskInput = new ortRuntime!.Tensor('float32', new Float32Array(1 * 1 * 256 * 256), [1, 1, 256, 256]);
  const hasMaskInput = new ortRuntime!.Tensor('float32', Float32Array.from([0]), [1]);
  const origImSize = new ortRuntime!.Tensor('float32', Float32Array.from([origHeight, origWidth]), [2]);

  // 自动匹配输入名称（不同导出格式名称可能不同）
  const feeds: Record<string, ort.Tensor> = {};
  const inputNames = decoderSession.inputNames;
  for (const name of inputNames) {
    const lower = name.toLowerCase();
    if (lower.includes('image_embedding') || lower === 'image_embeddings') feeds[name] = embedding;
    else if (lower.includes('point_coord')) feeds[name] = pointCoordsTensor;
    else if (lower.includes('point_label')) feeds[name] = pointLabelsTensor;
    else if (lower.includes('mask_input')) feeds[name] = maskInput;
    else if (lower.includes('has_mask')) feeds[name] = hasMaskInput;
    else if (lower.includes('orig_im_size') || lower.includes('orig_size')) feeds[name] = origImSize;
  }

  // 如果没匹配到 embedding 输入名，用第一个输入
  if (!feeds[inputNames[0]]) feeds[inputNames[0]] = embedding;

  const results = await decoderSession.run(feeds);

  // 自动匹配输出名称
  let maskTensor: ort.Tensor | null = null;
  let iouTensor: ort.Tensor | null = null;
  for (const name of decoderSession.outputNames) {
    const lower = name.toLowerCase();
    if (lower.includes('mask') && !lower.includes('low')) maskTensor = results[name];
    else if (lower.includes('iou')) iouTensor = results[name];
  }
  if (!maskTensor) maskTensor = results[decoderSession.outputNames[0]];
  if (!iouTensor) iouTensor = results[decoderSession.outputNames[1]] || results[decoderSession.outputNames[0]];

  const maskData = maskTensor.data as Float32Array;
  const iouData = iouTensor.data as Float32Array;
  const maskDims = maskTensor.dims;
  // mask 形状 [1, num_masks, H, W]，取第一个（或最优）
  const numMasks = maskDims[1];
  const maskH = maskDims[2];
  const maskW = maskDims[3];

  // 找 IoU 最高的 mask
  let bestIdx = 0;
  if (numMasks > 1 && iouData.length >= numMasks) {
    let bestIou = -Infinity;
    for (let i = 0; i < numMasks; i++) {
      if (iouData[i] > bestIou) { bestIou = iouData[i]; bestIdx = i; }
    }
  }

  // 提取最优 mask
  const maskSize = maskH * maskW;
  const bestMask = new Float32Array(maskSize);
  const offset = bestIdx * maskSize;
  for (let i = 0; i < maskSize; i++) {
    bestMask[i] = maskData[offset + i];
  }

  return {
    mask: bestMask,
    iou: iouData[bestIdx] || 0,
    width: maskW,
    height: maskH,
  };
}

/**
 * mask 二值化 + 轮廓提取 + 多边形简化
 */
function maskToPolygon(
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
  tolerance: number
): { binary: Uint8Array; polygon: { x: number; y: number }[] } {
  // 二值化
  const binary = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    binary[i] = mask[i] > threshold ? 1 : 0;
  }

  // 轮廓提取（复用 magicwand）
  const contour = extractContour(binary, width, height);

  // 多边形简化
  const polygon = simplifyPolygon(contour, tolerance);

  return { binary, polygon };
}

/**
 * 对图片进行 SAM 分割
 * @param image 图片元素
 * @param points 正/负点 prompt（可选）
 * @param box 框 prompt（可选，与 points 可同时使用）
 * @param config 配置
 */
export async function segment(
  image: HTMLImageElement,
  points: SamPoint[] = [],
  box: SamBox | null = null,
  config: SamConfig = DEFAULT_SAM_CONFIG
): Promise<SamResult> {
  if (!isModelLoaded()) throw new Error('SAM model not loaded');

  // 1. 图片编码（缓存）
  const { embedding, scale, padX, padY } = await encodeImage(image, config);

  // 2. prompt 解码
  const { mask, iou, width, height } = await runDecoder(
    embedding, points, box,
    image.width, image.height,
    scale, padX, padY, config
  );

  // 3. mask 转多边形
  const { binary, polygon } = maskToPolygon(
    mask, width, height,
    config.maskThreshold, config.simplifyTolerance
  );

  return {
    mask: binary,
    width,
    height,
    iou,
    polygon,
  };
}

/**
 * 清除 image embedding 缓存（切换图片时调用）
 */
export function clearCache(): void {
  cachedEmbedding = null;
  cachedImageKey = '';
}
