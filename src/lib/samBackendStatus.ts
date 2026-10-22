/** SAM3 后端连接状态探测（纯 UI 用）。
 *
 *  只做 /health 探测和状态同步，不参与推理，也不改任何现有调用逻辑：
 *  - 双击 exe 自动启动后，这里把「进程已拉起 → 模型加载中 → 已就绪」写进 ui，
 *    连接弹窗 / 分割面板 / 顶栏模型面板都读同一份状态。
 *  - 手动启动后端（没配 backend.local.json）同样能探测到。
 */
import { ui } from './state.svelte';

const CHECK_TIMEOUT_MS = 2500;
const DEFAULT_WATCH_MS = 90_000;
const WATCH_INTERVAL_MS = 1500;

let timer: ReturnType<typeof setInterval> | null = null;
let deadline = 0;
let checking = false;
/** 刚拉起进程的宽限期：uvicorn 要等模型加载完才开始监听 /health，
 *  这段时间里的连接失败是正常的「加载中」，不能显示成红色「未连接」。 */
let startupGraceUntil = 0;

export function backendBaseUrl(): string {
  return `http://127.0.0.1:${ui.samBackendPort || 1421}`;
}

/** Rust 那边已经 spawn 出进程（端口拿到了）：进入加载中，并给一段宽限期。 */
export function markBackendSpawned(graceMs = 90_000): void {
  ui.samBackendState = 'loading';
  startupGraceUntil = Date.now() + graceMs;
}

/** 当前是否还处在「刚 spawn、模型加载中」的宽限期 */
export function inStartupGrace(): boolean {
  return Date.now() < startupGraceUntil;
}

/** 探测一次 /health，并把状态写进 ui。返回模型是否已就绪。 */
export async function checkBackendStatus(): Promise<boolean> {
  if (checking) return ui.samBackendState === 'ready';
  checking = true;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  try {
    const resp = await fetch(`${backendBaseUrl()}/health`, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    ui.samPoseLoaded = data?.pose_loaded === true;
    ui.samFaceLoaded = data?.face_loaded === true;
    if (data?.model_loaded === true) {
      ui.samBackendState = 'ready';
      ui.samBackendError = '';
      startupGraceUntil = 0;
      return true;
    }
    ui.samBackendState = 'loading';
    return false;
  } catch (e: any) {
    ui.samPoseLoaded = false;
    ui.samFaceLoaded = false;
    // 「正在拉起进程」和宽限期内先别判失败：模型还没加载完时 /health 根本还没监听
    if (ui.samBackendState === 'starting') return false;
    if (Date.now() < startupGraceUntil) {
      ui.samBackendState = 'loading';
      return false;
    }
    ui.samBackendState = 'error';
    ui.samBackendError = e?.message || String(e);
    return false;
  } finally {
    clearTimeout(to);
    checking = false;
  }
}

/** 轮询直到就绪或超时。重复调用会延长截止时间，但只会有一个定时器。 */
export function watchBackendStatus(maxMs = DEFAULT_WATCH_MS): void {
  deadline = Date.now() + maxMs;
  if (timer !== null) return;
  void checkBackendStatus();
  timer = setInterval(async () => {
    if (ui.samBackendState === 'ready' || Date.now() > deadline) {
      stopBackendWatch();
      return;
    }
    const ok = await checkBackendStatus();
    if (ok) stopBackendWatch();
  }, WATCH_INTERVAL_MS);
}

export function stopBackendWatch(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** 「重新检查」按钮：短轮询 + 立即返回一次结果 */
export async function retryBackendStatus(): Promise<boolean> {
  watchBackendStatus(45_000);
  return checkBackendStatus();
}
