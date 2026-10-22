/** SAM Sidecar 前端封装
 * 优先走 Python GPU sidecar，失败回退浏览器 ONNX。
 */

import { ui } from './state.svelte';
import { markBackendSpawned } from './samBackendStatus';

export interface SidecarPoint {
  x: number;
  y: number;
  label: number;
}

export interface SidecarBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SidecarSegmentResult {
  polygon: { x: number; y: number }[];
  score: number;
  dec_ms: number;
  mask_size: [number, number];
}

let sidecarPort: number | null = null;
let sidecarAvailable = false;
let startPromise: Promise<boolean> | null = null;

/** 启动 sidecar（调用 Rust 命令）。并发调用复用同一个 Promise，避免 spawn 两份。 */
export function startSidecar(): Promise<boolean> {
  if (sidecarAvailable && sidecarPort) {
    ui.samBackendPort = sidecarPort;
    return Promise.resolve(true);
  }
  if (startPromise) return startPromise;
  ui.samBackendState = 'starting';
  startPromise = (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const port = await invoke<number>('sam_sidecar_start');
      sidecarPort = port;
      sidecarAvailable = true;
      ui.samBackendPort = port;
      // 进程已经起来了，模型还要加载；给 90 秒宽限期，期间保持「加载中」而不是报错
      markBackendSpawned(90_000);
      console.info(`[SAM Sidecar] Started on port ${port}`);
      return true;
    } catch (e: any) {
      console.warn('[SAM Sidecar] Start failed, falling back to browser ONNX:', e);
      sidecarAvailable = false;
      ui.samBackendState = 'error';
      ui.samBackendError = e?.message || String(e);
      return false;
    } finally {
      startPromise = null;
    }
  })();
  return startPromise;
}

/** 停止 sidecar */
export async function stopSidecar(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('sam_sidecar_stop');
  } catch (e) {
    console.warn('[SAM Sidecar] Stop failed:', e);
  }
  sidecarPort = null;
  sidecarAvailable = false;
  ui.samBackendState = 'idle';
  ui.samBackendError = '';
}

/** sidecar 是否可用 */
export function isSidecarAvailable(): boolean {
  return sidecarAvailable && !!sidecarPort;
}

/** 调用 sidecar 跑分割 */
export async function segmentViaSidecar(
  imagePath: string,
  imageB64: string,
  points: SidecarPoint[],
  box: SidecarBox | null
): Promise<SidecarSegmentResult | null> {
  if (!sidecarPort) return null;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<SidecarSegmentResult>('sam_segment', {
      req: {
        image_path: imagePath,
        image_b64: imageB64,
        points: points.length > 0 ? points : [],
        box,
      },
    });
    return result;
  } catch (e) {
    console.warn('[SAM Sidecar] Segment failed:', e);
    return null;
  }
}
