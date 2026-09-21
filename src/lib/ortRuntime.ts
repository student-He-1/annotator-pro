/** ONNX Runtime Web 统一入口
 *
 *  1. 使用 webgpu 构建（内部已含 wasm 回退能力），按需动态 import，不拖慢首屏。
 *  2. wasmPaths 用目录字符串指向本地 dist，避免从 CDN 加载失败；
 *     用对象指定具体文件会导致 webgpuInit 找不到（jsep 导出的是 jsepInit）。
 *  3. 双显卡笔记本（独显 + 核显）优先申请高性能适配器。
 */
import type * as ort from 'onnxruntime-web';

let ortPromise: Promise<typeof ort> | null = null;

export function getOrt(): Promise<typeof ort> {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import('onnxruntime-web/webgpu');

      // 指向本地 dist 目录，ORT 自动找 jsep wasm + mjs
      ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';

      // 多线程 wasm（需要 COOP/COEP headers，vite.config.ts 已配）
      ort.env.wasm.numThreads = Math.min(navigator.hardwareConcurrency || 4, 4);

      // 尽量挑独显，避免落到核显上
      const gpu = (navigator as any).gpu;
      if (gpu?.requestAdapter) {
        try {
          const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
          if (adapter) ort.env.webgpu.adapter = adapter;
        } catch {
          // 申请失败就交给 ORT 自己处理
        }
      }
      console.info('[ORT] WebGPU:', !!gpu, '| numThreads:', ort.env.wasm.numThreads,
        '| SAB:', typeof SharedArrayBuffer !== 'undefined', '| wasmPaths:', ort.env.wasm.wasmPaths);
      return ort;
    })();
  }
  return ortPromise;
}

/** 可用执行提供器：有 WebGPU 就优先 GPU，否则回退 wasm(CPU) */
export function getExecutionProviders(): string[] {
  const hasWebGPU = typeof navigator !== 'undefined' && !!(navigator as any).gpu;
  return hasWebGPU ? ['webgpu', 'wasm'] : ['wasm'];
}

export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as any).gpu;
}