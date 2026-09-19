<script lang="ts">
  import { t } from '$lib/i18n.svelte';
  import { splitDataset, exportSplitFiles } from '$lib/dataset';
  import { showToast } from '$lib/state.svelte';
  import type { SplitResult } from '$lib/dataset';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let trainRatio = $state(0.7);
  let valRatio = $state(0.2);
  let testRatio = $state(0.1);
  let onlyAnnotated = $state(false);
  let useSeed = $state(false);
  let seed = $state(42);
  let result = $state<SplitResult | null>(null);

  const totalRatio = $derived(trainRatio + valRatio + testRatio);
  const ratioValid = $derived(Math.abs(totalRatio - 1) < 0.01);

  function handleSplit() {
    if (!ratioValid) {
      showToast('比例之和必须等于 1.0', 'error');
      return;
    }
    try {
      result = splitDataset({
        train: trainRatio,
        val: valRatio,
        test: testRatio,
        onlyAnnotated,
        seed: useSeed ? seed : undefined,
      });
    } catch (e: any) {
      showToast(e.message || '划分失败', 'error');
    }
  }

  function handleExport() {
    if (!result) return;
    const files = exportSplitFiles(result);
    // 下载每个文件
    for (const f of files) {
      const blob = new Blob([f.content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      a.click();
      URL.revokeObjectURL(url);
    }
    showToast(`已导出 ${files.length} 个划分文件`, 'success');
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }
</script>

<div class="modal-backdrop" onclick={handleBackdropClick}>
  <div class="modal">
    <div class="modal-header">
      <h3>数据集划分</h3>
      <button class="close-btn" onclick={onClose}>×</button>
    </div>

    <div class="modal-body">
      <div class="section">
        <h4>划分比例</h4>
        <div class="ratio-row">
          <label>训练集</label>
          <input type="number" bind:value={trainRatio} min="0" max="1" step="0.05" />
          <span class="pct">{(trainRatio * 100).toFixed(0)}%</span>
        </div>
        <div class="ratio-row">
          <label>验证集</label>
          <input type="number" bind:value={valRatio} min="0" max="1" step="0.05" />
          <span class="pct">{(valRatio * 100).toFixed(0)}%</span>
        </div>
        <div class="ratio-row">
          <label>测试集</label>
          <input type="number" bind:value={testRatio} min="0" max="1" step="0.05" />
          <span class="pct">{(testRatio * 100).toFixed(0)}%</span>
        </div>
        <div class="ratio-total" class:invalid={!ratioValid}>
          合计: {totalRatio.toFixed(2)} {ratioValid ? '✓' : '✗ (必须等于 1.0)'}
        </div>
      </div>

      <div class="section">
        <label class="checkbox">
          <input type="checkbox" bind:checked={onlyAnnotated} />
          仅划分已标注图片
        </label>
        <label class="checkbox">
          <input type="checkbox" bind:checked={useSeed} />
          使用固定随机种子（结果可复现）
        </label>
        {#if useSeed}
          <div class="seed-row">
            <label>种子值</label>
            <input type="number" bind:value={seed} />
          </div>
        {/if}
      </div>

      <button class="btn primary" onclick={handleSplit} disabled={!ratioValid}>
        开始划分
      </button>

      {#if result}
        <div class="result-section">
          <h4>划分结果</h4>
          <div class="result-grid">
            <div class="result-card train">
              <div class="result-label">训练集</div>
              <div class="result-count">{result.stats.train} 张</div>
              <div class="result-anns">{result.stats.trainAnns} 标注</div>
            </div>
            <div class="result-card val">
              <div class="result-label">验证集</div>
              <div class="result-count">{result.stats.val} 张</div>
              <div class="result-anns">{result.stats.valAnns} 标注</div>
            </div>
            <div class="result-card test">
              <div class="result-label">测试集</div>
              <div class="result-count">{result.stats.test} 张</div>
              <div class="result-anns">{result.stats.testAnns} 标注</div>
            </div>
          </div>
          <div class="result-total">
            合计: {result.stats.total} 张图片 / {result.stats.trainAnns + result.stats.valAnns + result.stats.testAnns} 标注
          </div>
          <button class="btn primary" onclick={handleExport}>
            导出划分文件 (.txt)
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
    width: 480px; max-height: 85vh; overflow-y: auto;
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
  .section { margin-bottom: 20px; }
  .section h4 { margin: 0 0 12px; font-size: 13px; color: var(--text-secondary); text-transform: uppercase; }
  .ratio-row {
    display: flex; align-items: center; gap: 12px; margin-bottom: 8px;
  }
  .ratio-row label { width: 50px; font-size: 13px; color: var(--text-primary); }
  .ratio-row input {
    width: 80px; padding: 6px 8px; background: var(--bg-primary); border: 1px solid var(--border);
    border-radius: 4px; color: var(--text-primary); font-size: 13px;
  }
  .pct { font-size: 12px; color: var(--text-secondary); font-family: monospace; }
  .ratio-total {
    margin-top: 8px; font-size: 13px; color: #3fb950; font-family: monospace;
  }
  .ratio-total.invalid { color: #f85149; }
  .checkbox {
    display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-primary);
    margin-bottom: 8px; cursor: pointer;
  }
  .checkbox input { cursor: pointer; }
  .seed-row { display: flex; align-items: center; gap: 12px; margin-top: 8px; margin-left: 24px; }
  .seed-row label { font-size: 13px; color: var(--text-primary); }
  .seed-row input {
    width: 100px; padding: 6px 8px; background: var(--bg-primary); border: 1px solid var(--border);
    border-radius: 4px; color: var(--text-primary); font-size: 13px;
  }
  .btn {
    padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500;
    cursor: pointer; border: none; transition: background 0.15s;
  }
  .btn.primary { background: #238636; color: #fff; }
  .btn.primary:hover { background: #2ea043; }
  .btn.primary:disabled { background: var(--border); color: var(--text-secondary); cursor: not-allowed; }
  .result-section { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--border); }
  .result-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 12px; }
  .result-card {
    padding: 12px; border-radius: 6px; text-align: center; background: var(--bg-primary);
    border: 1px solid var(--border);
  }
  .result-card.train { border-color: #238636; }
  .result-card.val { border-color: #d2991d; }
  .result-card.test { border-color: #58a6ff; }
  .result-label { font-size: 12px; color: var(--text-secondary); text-transform: uppercase; margin-bottom: 4px; }
  .result-count { font-size: 20px; font-weight: 600; color: var(--text-primary); }
  .result-anns { font-size: 11px; color: var(--text-secondary); margin-top: 2px; }
  .result-total { font-size: 12px; color: var(--text-secondary); margin-bottom: 12px; text-align: center; }
</style>
