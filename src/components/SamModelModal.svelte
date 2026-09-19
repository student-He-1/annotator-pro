<script lang="ts">
  import { t } from '$lib/i18n.svelte';
  import { ui, images, addAnnotation, showToast, getNextAnnotationId, pushHistory, getActiveClass } from '$lib/state.svelte';
  import { loadModel, isModelLoaded, getModelName, segment, DEFAULT_SAM_CONFIG, clearCache } from '$lib/sam';
  import type { SamResult } from '$lib/sam';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  let encoderFile = $state<File | null>(null);
  let decoderFile = $state<File | null>(null);
  let maskThreshold = $state(DEFAULT_SAM_CONFIG.maskThreshold);
  let simplifyTolerance = $state(DEFAULT_SAM_CONFIG.simplifyTolerance);
  let multiMask = $state(DEFAULT_SAM_CONFIG.multiMask);
  let isRunning = $state(false);
  let lastResult = $state<SamResult | null>(null);
  let progress = $state({ current: 0, total: 0 });

  const modelLoaded = $derived(isModelLoaded());

  function handleEncoderFile(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) encoderFile = input.files[0];
  }
  function handleDecoderFile(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) decoderFile = input.files[0];
  }

  async function handleLoadModel() {
    if (!encoderFile || !decoderFile) {
      showToast('Please select both encoder and decoder ONNX files', 'error');
      return;
    }
    try {
      isRunning = true;
      await loadModel(encoderFile, decoderFile);
      showToast(`SAM model loaded: ${getModelName()}`, 'success');
    } catch (e: any) {
      showToast(`Failed to load model: ${e.message || e}`, 'error');
    } finally {
      isRunning = false;
    }
  }

  async function handleSegmentCurrent() {
    if (!ui.currentImage) { showToast('No image loaded', 'error'); return; }
    if (!isModelLoaded()) { showToast('Model not loaded', 'error'); return; }
    try {
      isRunning = true;
      // 用图片中心作为默认正点 prompt
      const cx = ui.currentImage.width / 2;
      const cy = ui.currentImage.height / 2;
      lastResult = await segment(ui.currentImage, [{ x: cx, y: cy, label: 1 }], null, {
        encoderInputSize: 1024,
        maskThreshold,
        simplifyTolerance,
        multiMask,
      });
      if (lastResult.polygon.length >= 3) {
        showToast(`Segmented: ${lastResult.polygon.length} vertices, IoU=${lastResult.iou.toFixed(2)}`, 'success');
      } else {
        showToast('No mask generated, try different prompt on canvas', 'error');
      }
    } catch (e: any) {
      showToast(`Segment failed: ${e.message || e}`, 'error');
    } finally {
      isRunning = false;
    }
  }

  async function handleSegmentAll() {
    if (images.length === 0) { showToast('No images loaded', 'error'); return; }
    if (!isModelLoaded()) { showToast('Model not loaded', 'error'); return; }
    try {
      isRunning = true;
      progress = { current: 0, total: images.length };
      let count = 0;
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        progress.current = i + 1;
        try {
          const cx = img.width / 2;
          const cy = img.height / 2;
          const result = await segment(img, [{ x: cx, y: cy, label: 1 }], null, {
            encoderInputSize: 1024,
            maskThreshold,
            simplifyTolerance,
            multiMask,
          });
          if (result.polygon.length >= 3) {
            const ann = {
              type: 'polygon' as const,
              points: result.polygon.map(p => ({ x: p.x, y: p.y })),
              className: getActiveClass(),
              id: getNextAnnotationId(),
            };
            // 切换到该图添加标注
            const prevIdx = ui.currentImageIndex;
            ui.currentImageIndex = i;
            addAnnotation(ann);
            ui.currentImageIndex = prevIdx;
            count++;
          }
        } catch { /* 跳过失败的图片 */ }
      }
      clearCache();
      showToast(`Auto-segmented ${count}/${images.length} images`, 'success');
    } catch (e: any) {
      showToast(`Batch segment failed: ${e.message || e}`, 'error');
    } finally {
      isRunning = false;
    }
  }
</script>

<div class="modal-overlay" onclick={onClose}>
  <div class="modal" onclick={e => e.stopPropagation()}>
    <div class="modal-header">
      <h3>SAM 智能分割</h3>
      <button class="close-btn" onclick={onClose}>×</button>
    </div>
    <div class="modal-body">
      {#if !modelLoaded}
        <div class="section">
          <h4>1. 加载模型</h4>
          <p class="hint">需要两个 ONNX 文件：image_encoder.onnx + prompt_encoder_mask_decoder.onnx</p>
          <p class="hint">推荐 MobileSAM（轻量，约 40MB）或 SAM ViT-B（约 370MB）</p>
          <div class="file-row">
            <label>Encoder (.onnx)</label>
            <input type="file" accept=".onnx" onchange={handleEncoderFile} />
            {#if encoderFile}<span class="file-name">{encoderFile.name}</span>{/if}
          </div>
          <div class="file-row">
            <label>Decoder (.onnx)</label>
            <input type="file" accept=".onnx" onchange={handleDecoderFile} />
            {#if decoderFile}<span class="file-name">{decoderFile.name}</span>{/if}
          </div>
          <button class="btn-primary" onclick={handleLoadModel} disabled={isRunning || !encoderFile || !decoderFile}>
            {isRunning ? '加载中...' : '加载模型'}
          </button>
        </div>
      {:else}
        <div class="section">
          <h4>模型已加载</h4>
          <p class="success">{getModelName()}</p>
        </div>
      {/if}

      <div class="section">
        <h4>2. 参数配置</h4>
        <div class="form-row">
          <label>Mask 阈值</label>
          <input type="number" bind:value={maskThreshold} step="0.1" min="-1" max="1" />
        </div>
        <div class="form-row">
          <label>多边形简化精度</label>
          <input type="number" bind:value={simplifyTolerance} step="0.5" min="0" max="10" />
        </div>
        <div class="form-row">
          <label>多 Mask 候选（取最优）</label>
          <input type="checkbox" bind:checked={multiMask} />
        </div>
      </div>

      {#if modelLoaded}
        <div class="section">
          <h4>3. 运行分割</h4>
          <p class="hint">在画布上使用 SAM 工具（M）：点击=正点，Shift+点击=负点，拖拽=框选</p>
          <div class="btn-row">
            <button class="btn-primary" onclick={handleSegmentCurrent} disabled={isRunning}>
              当前图片测试（中心点）
            </button>
            <button class="btn-secondary" onclick={handleSegmentAll} disabled={isRunning}>
              批量自动分割全部
            </button>
          </div>
          {#if isRunning && progress.total > 0}
            <div class="progress">
              <div class="progress-bar" style="width: {(progress.current / progress.total * 100).toFixed(0)}%"></div>
              <span>{progress.current}/{progress.total}</span>
            </div>
          {/if}
          {#if lastResult}
            <div class="result-info">
              <p>顶点数: {lastResult.polygon.length} | IoU: {lastResult.iou.toFixed(3)} | Mask: {lastResult.width}×{lastResult.height}</p>
            </div>
          {/if}
        </div>
      {/if}
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
  .section { margin-bottom: 20px; }
  .section h4 { margin: 0 0 10px; font-size: 14px; color: #58a6ff; }
  .hint { font-size: 12px; color: var(--text-secondary); margin: 4px 0; }
  .success { color: #3fb950; font-size: 13px; }
  .file-row { margin: 8px 0; }
  .file-row label { display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
  .file-row input[type="file"] { font-size: 12px; color: var(--text-primary); }
  .file-name { font-size: 11px; color: #3fb950; margin-left: 8px; }
  .form-row {
    display: flex; align-items: center; justify-content: space-between;
    margin: 8px 0;
  }
  .form-row label { font-size: 13px; }
  .form-row input[type="number"] {
    width: 80px; padding: 4px 8px; background: var(--bg-primary); border: 1px solid var(--border);
    border-radius: 4px; color: var(--text-primary); font-size: 13px;
  }
  .btn-row { display: flex; gap: 10px; margin-top: 10px; }
  .btn-primary {
    padding: 8px 16px; background: #238636; border: 1px solid #2ea043;
    border-radius: 6px; color: #fff; cursor: pointer; font-size: 13px;
  }
  .btn-primary:hover { background: #2ea043; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary {
    padding: 8px 16px; background: var(--bg-tertiary); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text-primary); cursor: pointer; font-size: 13px;
  }
  .btn-secondary:hover { background: var(--border); }
  .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
  .progress { margin-top: 10px; position: relative; height: 20px; background: var(--bg-primary); border-radius: 4px; overflow: hidden; }
  .progress-bar { height: 100%; background: #238636; transition: width 0.2s; }
  .progress span { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 11px; }
  .result-info { margin-top: 10px; padding: 8px 12px; background: var(--bg-primary); border-radius: 4px; font-size: 12px; color: var(--text-secondary); }
</style>
