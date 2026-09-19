<script lang="ts">
  import { t } from '$lib/i18n.svelte';
  import { ui, images, addAnnotation, showToast, getNextAnnotationId } from '$lib/state.svelte';
  import { loadModel, isModelLoaded, getModelName, getClassNames, detect, DEFAULT_YOLO_CONFIG } from '$lib/yolo';
  import type { Detection } from '$lib/yolo';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let modelFile = $state<File | null>(null);
  let namesFile = $state<File | null>(null);
  let confThreshold = $state(DEFAULT_YOLO_CONFIG.confThreshold);
  let iouThreshold = $state(DEFAULT_YOLO_CONFIG.iouThreshold);
  let inputSize = $state(DEFAULT_YOLO_CONFIG.inputSize);
  let isRunning = $state(false);
  let detections = $state<Detection[]>([]);
  let selectedDetections = $state<Set<number>>(new Set());
  let progress = $state({ current: 0, total: 0 });

  const modelLoaded = $derived(isModelLoaded());

  function handleModelFile(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      modelFile = input.files[0];
    }
  }

  function handleNamesFile(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      namesFile = input.files[0];
    }
  }

  async function handleLoadModel() {
    if (!modelFile) {
      showToast('Please select a model file', 'error');
      return;
    }
    try {
      isRunning = true;
      await loadModel(modelFile, namesFile || undefined);
      showToast(`Model loaded: ${getModelName()} (${getClassNames().length} classes)`, 'success');
    } catch (e: any) {
      showToast(`Failed to load model: ${e.message}`, 'error');
    } finally {
      isRunning = false;
    }
  }

  async function handleDetectCurrent() {
    if (!ui.currentImage) {
      showToast('No image loaded', 'error');
      return;
    }
    try {
      isRunning = true;
      detections = await detect(ui.currentImage, {
        confThreshold,
        iouThreshold,
        inputSize,
        modelFormat: 'auto',
      });
      // 默认全选
      selectedDetections = new Set(detections.map((_, i) => i));
      showToast(`Found ${detections.length} object(s)`, 'success');
    } catch (e: any) {
      showToast(`Detection failed: ${e.message}`, 'error');
    } finally {
      isRunning = false;
    }
  }

  async function handleDetectAll() {
    if (images.length === 0) {
      showToast('No images loaded', 'error');
      return;
    }
    try {
      isRunning = true;
      progress = { current: 0, total: images.length };
      let totalDetections = 0;

      for (let i = 0; i < images.length; i++) {
        progress.current = i + 1;
        const imgData = images[i];
        const img = new Image();
        img.src = imgData.dataUrl;
        await new Promise(resolve => { img.onload = resolve; });

        const dets = await detect(img, {
          confThreshold,
          iouThreshold,
          inputSize,
          modelFormat: 'auto',
        });

        // 直接添加到标注
        for (const det of dets) {
          addAnnotation({
            type: 'rect',
            x: Math.max(0, det.x),
            y: Math.max(0, det.y),
            w: det.w,
            h: det.h,
            className: det.className,
            id: getNextAnnotationId(),
          });
        }
        totalDetections += dets.length;
      }

      showToast(`Auto-annotated ${images.length} images, ${totalDetections} objects`, 'success');
      onClose();
    } catch (e: any) {
      showToast(`Batch detection failed: ${e.message}`, 'error');
    } finally {
      isRunning = false;
    }
  }

  function toggleDetection(idx: number) {
    const newSet = new Set(selectedDetections);
    if (newSet.has(idx)) {
      newSet.delete(idx);
    } else {
      newSet.add(idx);
    }
    selectedDetections = newSet;
  }

  function handleAcceptSelected() {
    if (selectedDetections.size === 0) {
      showToast('No detections selected', 'error');
      return;
    }
    let count = 0;
    for (const idx of selectedDetections) {
      const det = detections[idx];
      addAnnotation({
        type: 'rect',
        x: Math.max(0, det.x),
        y: Math.max(0, det.y),
        w: det.w,
        h: det.h,
        className: det.className,
        id: getNextAnnotationId(),
      });
      count++;
    }
    showToast(`Added ${count} annotation(s)`, 'success');
    onClose();
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }
</script>

<div class="modal-backdrop" onclick={handleBackdropClick}>
  <div class="modal">
    <div class="modal-header">
      <h3>AI 预标注 (YOLO)</h3>
      <button class="close-btn" onclick={onClose}>×</button>
    </div>

    <div class="modal-body">
      <!-- 模型加载 -->
      <div class="section">
        <h4>1. 加载模型</h4>
        <div class="file-row">
          <label class="file-label">
            <span>模型文件 (.onnx)</span>
            <input type="file" accept=".onnx" onchange={handleModelFile} />
            <span class="file-name">{modelFile?.name || '未选择'}</span>
          </label>
        </div>
        <div class="file-row">
          <label class="file-label">
            <span>类别文件 (.names/.txt，可选)</span>
            <input type="file" accept=".names,.txt" onchange={handleNamesFile} />
            <span class="file-name">{namesFile?.name || '默认 COCO 80类'}</span>
          </label>
        </div>
        <button class="btn primary" onclick={handleLoadModel} disabled={!modelFile || isRunning}>
          {isRunning ? '加载中...' : '加载模型'}
        </button>
        {#if modelLoaded}
          <div class="model-status">✓ 已加载: {getModelName()} ({getClassNames().length} 类)</div>
        {/if}
      </div>

      <!-- 参数配置 -->
      <div class="section">
        <h4>2. 参数配置</h4>
        <div class="param-row">
          <label>置信度阈值</label>
          <input type="number" bind:value={confThreshold} min="0" max="1" step="0.05" />
          <span class="param-hint">越高越严格</span>
        </div>
        <div class="param-row">
          <label>NMS IoU 阈值</label>
          <input type="number" bind:value={iouThreshold} min="0" max="1" step="0.05" />
          <span class="param-hint">去重重叠框</span>
        </div>
        <div class="param-row">
          <label>输入尺寸</label>
          <input type="number" bind:value={inputSize} min="320" max="1280" step="32" />
          <span class="param-hint">通常 640</span>
        </div>
      </div>

      <!-- 运行检测 -->
      <div class="section">
        <h4>3. 运行检测</h4>
        <div class="btn-row">
          <button class="btn primary" onclick={handleDetectCurrent} disabled={!modelLoaded || isRunning}>
            检测当前图片
          </button>
          <button class="btn" onclick={handleDetectAll} disabled={!modelLoaded || isRunning}>
            批量检测所有图片
          </button>
        </div>
        {#if isRunning && progress.total > 0}
          <div class="progress-bar">
            <div class="progress-fill" style="width: {(progress.current / progress.total * 100).toFixed(0)}%"></div>
            <span class="progress-text">{progress.current} / {progress.total}</span>
          </div>
        {/if}
      </div>

      <!-- 检测结果 -->
      {#if detections.length > 0}
        <div class="section">
          <h4>4. 检测结果 ({detections.length})</h4>
          <div class="detection-list">
            {#each detections as det, idx}
              <label class="detection-item" class:selected={selectedDetections.has(idx)}>
                <input type="checkbox" checked={selectedDetections.has(idx)} onchange={() => toggleDetection(idx)} />
                <span class="det-class">{det.className}</span>
                <span class="det-conf">{(det.confidence * 100).toFixed(1)}%</span>
                <span class="det-coord">{det.w.toFixed(0)}×{det.h.toFixed(0)}</span>
              </label>
            {/each}
          </div>
          <button class="btn primary accept-btn" onclick={handleAcceptSelected} disabled={selectedDetections.size === 0}>
            接受选中 ({selectedDetections.size}) 并添加标注
          </button>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .modal {
    background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px;
    width: 520px; max-height: 85vh; overflow-y: auto;
  }
  .modal-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 16px 20px; border-bottom: 1px solid var(--border);
  }
  .modal-header h3 { margin: 0; font-size: 16px; color: var(--text-primary); }
  .close-btn {
    background: none; border: none; color: var(--text-secondary); font-size: 24px;
    cursor: pointer; line-height: 1; padding: 0 4px;
  }
  .close-btn:hover { color: var(--text-primary); }
  .modal-body { padding: 20px; }
  .section { margin-bottom: 24px; }
  .section h4 { margin: 0 0 12px; font-size: 13px; color: var(--text-secondary); text-transform: uppercase; }
  .file-row { margin-bottom: 10px; }
  .file-label {
    display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-primary);
    cursor: pointer;
  }
  .file-label input[type="file"] {
    padding: 6px; background: var(--bg-primary); border: 1px solid var(--border);
    border-radius: 4px; color: var(--text-primary); font-size: 12px;
  }
  .file-name { font-size: 11px; color: var(--text-muted); font-family: monospace; }
  .model-status {
    margin-top: 8px; padding: 8px 12px; background: rgba(35,134,54,0.15);
    border: 1px solid #238636; border-radius: 4px; font-size: 12px; color: #3fb950;
  }
  .param-row {
    display: flex; align-items: center; gap: 12px; margin-bottom: 8px;
  }
  .param-row label { width: 120px; font-size: 13px; color: var(--text-primary); }
  .param-row input {
    width: 80px; padding: 6px 8px; background: var(--bg-primary); border: 1px solid var(--border);
    border-radius: 4px; color: var(--text-primary); font-size: 13px;
  }
  .param-hint { font-size: 11px; color: var(--text-muted); }
  .btn-row { display: flex; gap: 10px; }
  .btn {
    padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500;
    cursor: pointer; border: 1px solid var(--border); background: var(--bg-tertiary); color: var(--text-primary);
    transition: background 0.15s;
  }
  .btn:hover { background: var(--border); }
  .btn.primary { background: #238636; border-color: #238636; color: #fff; }
  .btn.primary:hover { background: #2ea043; }
  .btn:disabled { background: var(--border); border-color: var(--border); color: var(--text-secondary); cursor: not-allowed; }
  .progress-bar {
    position: relative; margin-top: 10px; height: 24px; background: var(--bg-primary);
    border-radius: 4px; overflow: hidden; border: 1px solid var(--border);
  }
  .progress-fill {
    height: 100%; background: #238636; transition: width 0.3s;
  }
  .progress-text {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-size: 12px; color: var(--text-primary); font-family: monospace;
  }
  .detection-list { max-height: 200px; overflow-y: auto; margin-bottom: 12px; }
  .detection-item {
    display: flex; align-items: center; gap: 10px; padding: 6px 10px;
    border-radius: 4px; cursor: pointer; font-size: 12px;
  }
  .detection-item:hover { background: var(--bg-tertiary); }
  .detection-item.selected { background: rgba(35,134,54,0.15); }
  .det-class { flex: 1; color: var(--text-primary); font-weight: 500; }
  .det-conf { color: #3fb950; font-family: monospace; width: 50px; }
  .det-coord { color: var(--text-secondary); font-family: monospace; width: 70px; text-align: right; }
  .accept-btn { width: 100%; }
</style>
