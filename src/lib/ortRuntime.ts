/** ONNX Runtime Web 统一入口
 *
 *  1. 使用 webgpu 构建（内部已含 wasm 回退能力），按需动态 import，不拖慢首屏。
 *  2. wasm 运行时用 Vite 的 `?url` 打进 dist，再用 {mjs, wasm} 显式指定位置。
 *     不能写成 `/node_modules/onnxruntime-web/dist/` —— 那个路径只有 vite dev server
 *     才有；`tauri build` 之后前端资源是从 `tauri://localhost` 加载的，
 *     /node_modules 根本不存在，于是 YOLO 一加载模型就 fetch 失败。
 *     也不能什么都不配：webgpu 的 bundle 构建里虽然内嵌了 wasm，但一旦检测到
 *     scriptSrc 不可判定就会直接 throw（"cannot determine the script source URL."）。
 *  3. 双显卡笔记本（独显 + 核显）优先申请高性能适配器。
 */
import type * as ort from 'onnxruntime-web';

// onnxruntime-web 的 wasm 运行时本体：
//   .mjs  —— emscripten 胶水（导出的默认工厂函数），线程 worker 也由它自己 new Worker(import.meta.url) 派生
//   .wasm —— 真正的编译产物，胶水内部只通过 locateFile("ort-wasm-simd-threaded.asyncify.wasm") 取它
// 文件名必须和这个构建实际要的那一对一致。webgpu 构建内部走的正是 asyncify 变体
// （ort.webgpu.bundle.min.mjs 里解析出来的就是 ort-wasm-simd-threaded.asyncify.mjs）。
// 之前有人用 jsep 那对文件配 wasmPaths 对象形式，结果报「webgpuInit 找不到」——
// 根因是文件名对不上，不是对象形式本身不能用。
import wasmMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import wasmBinUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';

let ortPromise: Promise<typeof ort> | null = null;

export function getOrt(): Promise<typeof ort> {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import('onnxruntime-web/webgpu');

      // 用对象形式精确指定两个文件：dev 下是 vite 提供的路径，
      // 打包后是 dist/assets/ 里的哈希文件名（由 tauri 一起嵌进 exe）。
      ort.env.wasm.wasmPaths = { mjs: wasmMjsUrl, wasm: wasmBinUrl } as any;

      // 多线程 wasm 需要 SharedArrayBuffer（COOP/COEP）。vite dev 配了这两个头，
      // 但打包后的 tauri:// 协议没有 —— 好在 ORT 自己会发现 crossOriginIsolated=false
      // 并把 numThreads 降回 1，这里照旧设上限即可。
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
        '| SAB:', typeof SharedArrayBuffer !== 'undefined',
        '| crossOriginIsolated:', (globalThis as any).crossOriginIsolated,
        '| wasm:', wasmMjsUrl);
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
