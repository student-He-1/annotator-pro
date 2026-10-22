<script lang="ts">
  /** 顶栏「模型状态」面板 —— 三种工作模式共用。
   *
   *  只展示 / 启动 / 检查，不代替各模式里的「连接」：
   *  - 检测模式：SAM 智能分割弹窗里点连接
   *  - 分割模式：图像分割面板里点连接
   *  这里让用户随时知道后端在不在、模型加载到哪一步、YOLO 导入了哪个。
   */
  import { ui, showToast } from '$lib/state.svelte';
  import { startSidecar } from '$lib/samSidecar';
  import { retryBackendStatus, watchBackendStatus } from '$lib/samBackendStatus';
  import { loadModel, isModelLoaded } from '$lib/yolo';
  import Icon from './Icon.svelte';
  import { onMount } from 'svelte';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  let busy = $state(false);
  let yoloLoading = $state(false);
  let yoloInput: HTMLInputElement;

  const hasTauri = typeof window !== 'undefined'
    && (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__);

  const dotClass = $derived(
    ui.samBackendState === 'ready' ? 'ok'
      : (ui.samBackendState === 'starting' || ui.samBackendState === 'loading') ? 'busy'
      : ui.samBackendState === 'error' ? 'err' : ''
  );

  const samStatusText = $derived(
    ui.samBackendState === 'ready'
      ? (ui.samModelReady ? '已连接 · 可以使用' : '模型已就绪 · 可以连接')
      : ui.samBackendState === 'starting' ? '正在启动后端进程…'
      : ui.samBackendState === 'loading' ? '模型正在加载中…（首次约 10~30 秒）'
      : ui.samBackendState === 'error' ? '未连接'
      : '未启动'
  );

  async function refreshBackend() {
    if (busy) return;
    busy = true;
    try {
      if (hasTauri && ui.samBackendState !== 'ready') {
        // 没配 backend.local.json 时这里会失败，随后 /health 探测会给出明确状态
        await startSidecar().catch(() => false);
      }
      const ok = await retryBackendStatus();
      if (ok) showToast('SAM3 模型已就绪', 'success');
      else if (ui.samBackendState === 'loading') showToast('后端在线，模型还在加载，请稍候…', 'info');
      else if (ui.samBackendState === 'starting') showToast('正在启动后端…', 'info');
      else showToast('连不上后端：检查 backend.local.json 或手动启动 sam_server.py', 'error');
    } finally {
      busy = false;
    }
  }

  async function pickYolo(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    if (!f) return;
    yoloLoading = true;
    try {
      await loadModel(f);
      showToast(`YOLO 模型已加载：${f.name}`, 'success');
    } catch (err: any) {
      showToast('YOLO 模型加载失败：' + (err?.message || err), 'error');
    } finally {
      yoloLoading = false;
      input.value = '';
    }
  }

  // 打开面板时如果状态未知/失败，补一次轮询；已经就绪就不打扰。
  // 不在这里停轮询：顶栏小圆点还要继续更新，watch 自己会在就绪/超时后停。
  onMount(() => {
    if (ui.samBackendState !== 'ready') {
      watchBackendStatus(45_000);
    }
  });
</script>

<div class="modal-overlay" role="presentation" onclick={onClose}>
  <div class="modal" role="presentation" onclick={e => e.stopPropagation()}>
    <div class="modal-header">
      <h3>模型状态</h3>
      <button class="close-btn" onclick={onClose}>×</button>
    </div>
    <div class="modal-body">
      <!-- SAM3 后端 -->
      <div class="section">
        <div class="row-between">
          <div class="model-title">
            <span class="model-icon"><Icon name="sam" size={16} /></span>
            <div>
              <div class="model-name">SAM 3（GPU）</div>
              <div class="model-sub">Python 推理后端 · localhost:{ui.samBackendPort}</div>
            </div>
          </div>
          <button class="btn-mini" onclick={refreshBackend} disabled={busy}>
            {busy ? '检查中…' : (ui.samBackendState === 'ready' ? '重新检查' : '启动并检查')}
          </button>
        </div>
        <div class="status-line">
          <span class="dot" class:ok={dotClass === 'ok'} class:busy={dotClass === 'busy'} class:err={dotClass === 'err'}></span>
          <span class:ok-text={dotClass === 'ok'} class:busy-text={dotClass === 'busy'} class:err-text={dotClass === 'err'}>
            {samStatusText}
          </span>
        </div>
        {#if ui.samBackendState === 'error' && ui.samBackendError}
          <p class="hint">原因：{ui.samBackendError}</p>
        {/if}
        <p class="hint">
          用于：检测模式 SAM 工具 / 智能分割、分割模式全部功能。
          在对应模式里点「连接」即可开始工作。
        </p>
      </div>

      <!-- YOLO ONNX -->
      <div class="section">
        <div class="row-between">
          <div class="model-title">
            <span class="model-icon"><Icon name="cpu" size={16} /></span>
            <div>
              <div class="model-name">YOLO（ONNX 本地推理）</div>
              <div class="model-sub">
                {ui.yoloModelName ? `${ui.yoloModelName} · ${ui.yoloClassCount} 类` : '未加载 · 需要手动导入 .onnx'}
              </div>
            </div>
          </div>
          <button class="btn-mini" onclick={() => yoloInput.click()} disabled={yoloLoading}>
            {yoloLoading ? '加载中…' : (ui.yoloModelName ? '更换模型' : '导入 .onnx')}
          </button>
          <input style="display:none" type="file" accept=".onnx" bind:this={yoloInput} onchange={pickYolo} />
        </div>
        <div class="status-line">
          <span class="dot" class:ok={isModelLoaded()}></span>
          <span class:ok-text={isModelLoaded()}>{isModelLoaded() ? '已加载' : '未加载'}</span>
        </div>
        <p class="hint">
          用于：检测模式 YOLO 预标注、分割模式「YOLO 框 → 掩膜」。
          三种模式共用同一个模型，导入后本次会话有效。
        </p>
      </div>

      <!-- 按需加载模型 -->
      <div class="section">
        <div class="model-title">
          <span class="model-icon"><Icon name="keypoint" size={16} /></span>
          <div>
            <div class="model-name">关键点模型（按需加载）</div>
            <div class="model-sub">第一次点击「一键检测」时才加载，需要等一会儿</div>
          </div>
        </div>
        <div class="kv">
          <span>人体 17 点 · YOLOv8n-pose</span>
          <span class="dot" class:ok={ui.samPoseLoaded}></span>
          <span class="kv-status" class:ok-text={ui.samPoseLoaded}>
            {ui.samPoseLoaded ? '已加载' : '按需加载 · 首次约 10~20 秒'}
          </span>
        </div>
        <div class="kv">
          <span>人脸 68 点 · face_alignment 2DFAN4</span>
          <span class="dot" class:ok={ui.samFaceLoaded}></span>
          <span class="kv-status" class:ok-text={ui.samFaceLoaded}>
            {ui.samFaceLoaded ? '已加载' : '按需加载 · 首次约 10~20 秒'}
          </span>
        </div>
        <p class="hint">
          加载状态来自后端 /health；模型文件路径在 backend.local.json 里配置。
        </p>
      </div>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .modal {
    background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px;
    width: 520px; max-height: 85vh; overflow-y: auto; color: var(--text-primary);
  }
  .modal-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 14px 18px; border-bottom: 1px solid var(--border);
  }
  .modal-header h3 { margin: 0; font-size: 16px; }
  .close-btn {
    background: none; border: none; color: var(--text-secondary); font-size: 22px;
    cursor: pointer; padding: 0 4px;
  }
  .close-btn:hover { color: var(--text-primary); }
  .modal-body { padding: 16px 18px; }
  .section { margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
  .section:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }

  .row-between { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .model-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .model-icon { color: var(--accent-blue, #58a6ff); display: flex; }
  .model-name { font-size: 14px; font-weight: 600; }
  .model-sub { font-size: 11px; color: var(--text-muted); margin-top: 2px; word-break: break-all; }

  .status-line { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; color: var(--text-secondary); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); flex: none; }
  .dot.ok { background: #3fb950; box-shadow: 0 0 5px rgba(63,185,80,0.7); }
  .dot.busy { background: #d2991d; animation: pulse 1.1s ease-in-out infinite; }
  .dot.err { background: #f85149; }
  .ok-text { color: #3fb950; }
  .busy-text { color: #d2991d; }
  .err-text { color: #f85149; }

  .hint { font-size: 12px; color: var(--text-muted); margin: 6px 0 0; line-height: 1.5; }

  .kv {
    display: flex; align-items: center; gap: 8px;
    font-size: 12px; color: var(--text-secondary); margin-top: 10px;
  }
  .kv-status { margin-left: auto; color: var(--text-muted); }

  .btn-mini {
    background: var(--bg-tertiary); border: 1px solid var(--border);
    color: var(--text-secondary); border-radius: 6px;
    padding: 5px 10px; font-size: 12px; cursor: pointer; font-family: inherit;
    white-space: nowrap;
  }
  .btn-mini:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-hover); }
  .btn-mini:disabled { opacity: 0.4; cursor: not-allowed; }

  @keyframes pulse { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }
</style>
