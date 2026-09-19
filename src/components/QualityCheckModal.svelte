<script lang="ts">
  import { t } from '$lib/i18n.svelte';
  import { runQualityCheck, DEFAULT_QUALITY_CONFIG } from '$lib/quality';
  import { showToast, ui } from '$lib/state.svelte';
  import type { QualityReport, QualityIssue } from '$lib/quality';

  interface Props {
    onClose: () => void;
    onJumpToImage: (imageName: string) => void;
  }

  let { onClose, onJumpToImage }: Props = $props();

  let minBoxSize = $state(DEFAULT_QUALITY_CONFIG.minBoxSize);
  let overlapThreshold = $state(DEFAULT_QUALITY_CONFIG.overlapThreshold);
  let checkUnannotated = $state(DEFAULT_QUALITY_CONFIG.checkUnannotated);
  let checkEmptyClass = $state(DEFAULT_QUALITY_CONFIG.checkEmptyClass);
  let checkOverlap = $state(DEFAULT_QUALITY_CONFIG.checkOverlap);
  let checkTooSmall = $state(DEFAULT_QUALITY_CONFIG.checkTooSmall);
  let checkOutOfBounds = $state(DEFAULT_QUALITY_CONFIG.checkOutOfBounds);
  let report = $state<QualityReport | null>(null);
  let filterType = $state<string>('all');

  const filteredIssues = $derived.by(() => {
    if (!report) return [];
    if (filterType === 'all') return report.issues;
    if (filterType === 'error') return report.issues.filter(i => i.severity === 'error');
    if (filterType === 'warning') return report.issues.filter(i => i.severity === 'warning');
    return report.issues.filter(i => i.type === filterType);
  });

  function handleCheck() {
    report = runQualityCheck({
      minBoxSize,
      overlapThreshold,
      checkUnannotated,
      checkEmptyClass,
      checkOverlap,
      checkTooSmall,
      checkOutOfBounds,
    });
    if (report.passed) {
      showToast('标注质量校验通过！', 'success');
    } else {
      showToast(`发现 ${report.issues.filter(i => i.severity === 'error').length} 个错误`, 'error');
    }
  }

  function handleJump(issue: QualityIssue) {
    onJumpToImage(issue.image);
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  const issueTypeLabels: Record<string, string> = {
    unannotated: '未标注',
    empty_class: '空类别',
    overlap: '重叠',
    too_small: '过小',
    out_of_bounds: '越界',
    no_class: '未知类别',
  };
</script>

<div class="modal-backdrop" onclick={handleBackdropClick}>
  <div class="modal">
    <div class="modal-header">
      <h3>标注质量校验</h3>
      <button class="close-btn" onclick={onClose}>×</button>
    </div>

    <div class="modal-body">
      <div class="section">
        <h4>检测选项</h4>
        <div class="options-grid">
          <label class="checkbox">
            <input type="checkbox" bind:checked={checkUnannotated} />
            未标注图片
          </label>
          <label class="checkbox">
            <input type="checkbox" bind:checked={checkEmptyClass} />
            空类别名
          </label>
          <label class="checkbox">
            <input type="checkbox" bind:checked={checkOverlap} />
            重叠框
          </label>
          <label class="checkbox">
            <input type="checkbox" bind:checked={checkTooSmall} />
            过小框
          </label>
          <label class="checkbox">
            <input type="checkbox" bind:checked={checkOutOfBounds} />
            越界标注
          </label>
        </div>
        <div class="param-row">
          <label>最小框尺寸 (px)</label>
          <input type="number" bind:value={minBoxSize} min="1" />
        </div>
        <div class="param-row">
          <label>重叠IoU阈值</label>
          <input type="number" bind:value={overlapThreshold} min="0" max="1" step="0.05" />
        </div>
      </div>

      <button class="btn primary" onclick={handleCheck}>
        开始检测
      </button>

      {#if report}
        <div class="report-section">
          <div class="report-summary" class:passed={report.passed} class:failed={!report.passed}>
            <div class="summary-status">
              {report.passed ? '✓ 全部通过' : `✗ 发现 ${report.issues.length} 个问题`}
            </div>
            <div class="summary-stats">
              <span>{report.totalImages} 张图片</span>
              <span>{report.annotatedImages} 已标注</span>
              <span>{report.totalAnnotations} 标注</span>
              <span class="issue-count">{report.issues.length} 问题</span>
            </div>
          </div>

          {#if report.issues.length > 0}
            <div class="filter-bar">
              <button class="filter-btn" class:active={filterType === 'all'} onclick={() => filterType = 'all'}>
                全部 ({report.issues.length})
              </button>
              <button class="filter-btn error" class:active={filterType === 'error'} onclick={() => filterType = 'error'}>
                错误 ({report.issues.filter(i => i.severity === 'error').length})
              </button>
              <button class="filter-btn warning" class:active={filterType === 'warning'} onclick={() => filterType = 'warning'}>
                警告 ({report.issues.filter(i => i.severity === 'warning').length})
              </button>
            </div>

            <div class="issue-type-bar">
              {#each Object.entries(report.issueCounts) as [type, count]}
                <button class="type-btn" class:active={filterType === type} onclick={() => filterType = type}>
                  {issueTypeLabels[type] || type} ({count})
                </button>
              {/each}
            </div>

            <div class="issue-list">
              {#each filteredIssues as issue (issue.image + issue.annotationId + issue.type)}
                <div class="issue-item" class:error={issue.severity === 'error'} class:warning={issue.severity === 'warning'}>
                  <div class="issue-icon">{issue.severity === 'error' ? '✗' : '⚠'}</div>
                  <div class="issue-content">
                    <div class="issue-message">{issue.message}</div>
                    <div class="issue-meta">
                      <span class="issue-type">{issueTypeLabels[issue.type] || issue.type}</span>
                      <span class="issue-image">{issue.image}</span>
                    </div>
                  </div>
                  <button class="jump-btn" onclick={() => handleJump(issue)}>跳转</button>
                </div>
              {/each}
              {#if filteredIssues.length === 0}
                <div class="no-issues">没有匹配的问题</div>
              {/if}
            </div>
          {/if}
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
    width: 560px; max-height: 85vh; overflow-y: auto;
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
  .options-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px;
  }
  .checkbox {
    display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-primary);
    cursor: pointer;
  }
  .checkbox input { cursor: pointer; }
  .param-row {
    display: flex; align-items: center; gap: 12px; margin-bottom: 8px;
  }
  .param-row label { width: 160px; font-size: 13px; color: var(--text-primary); }
  .param-row input {
    width: 80px; padding: 6px 8px; background: var(--bg-primary); border: 1px solid var(--border);
    border-radius: 4px; color: var(--text-primary); font-size: 13px;
  }
  .btn {
    padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500;
    cursor: pointer; border: none; transition: background 0.15s;
  }
  .btn.primary { background: #238636; color: #fff; }
  .btn.primary:hover { background: #2ea043; }
  .report-section { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--border); }
  .report-summary {
    padding: 16px; border-radius: 6px; margin-bottom: 16px;
  }
  .report-summary.passed { background: rgba(35,134,54,0.15); border: 1px solid #238636; }
  .report-summary.failed { background: rgba(248,81,73,0.15); border: 1px solid #f85149; }
  .summary-status {
    font-size: 18px; font-weight: 600; margin-bottom: 8px;
  }
  .passed .summary-status { color: #3fb950; }
  .failed .summary-status { color: #f85149; }
  .summary-stats {
    display: flex; gap: 16px; font-size: 12px; color: var(--text-secondary);
  }
  .issue-count { color: #f85149; font-weight: 600; }
  .filter-bar { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .filter-btn {
    padding: 4px 10px; border-radius: 4px; font-size: 12px; cursor: pointer;
    background: var(--bg-tertiary); border: 1px solid var(--border); color: var(--text-secondary);
  }
  .filter-btn:hover { border-color: var(--text-secondary); color: var(--text-primary); }
  .filter-btn.active { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .filter-btn.error.active { background: #f85149; border-color: #f85149; }
  .filter-btn.warning.active { background: #d2991d; border-color: #d2991d; }
  .issue-type-bar { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
  .type-btn {
    padding: 3px 8px; border-radius: 3px; font-size: 11px; cursor: pointer;
    background: transparent; border: 1px solid var(--border); color: var(--text-secondary);
  }
  .type-btn:hover { border-color: var(--text-secondary); }
  .type-btn.active { background: var(--border); color: var(--text-primary); }
  .issue-list { max-height: 300px; overflow-y: auto; }
  .issue-item {
    display: flex; align-items: center; gap: 12px; padding: 10px 12px;
    border-radius: 4px; margin-bottom: 6px; background: var(--bg-primary);
    border-left: 3px solid var(--border);
  }
  .issue-item.error { border-left-color: #f85149; }
  .issue-item.warning { border-left-color: #d2991d; }
  .issue-icon {
    width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
    border-radius: 50%; font-size: 12px; flex-shrink: 0;
  }
  .error .issue-icon { background: rgba(248,81,73,0.2); color: #f85149; }
  .warning .issue-icon { background: rgba(210,153,29,0.2); color: #d2991d; }
  .issue-content { flex: 1; min-width: 0; }
  .issue-message { font-size: 13px; color: var(--text-primary); margin-bottom: 2px; }
  .issue-meta { display: flex; gap: 12px; font-size: 11px; color: var(--text-secondary); }
  .issue-type { text-transform: uppercase; }
  .issue-image { font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .jump-btn {
    padding: 4px 10px; border-radius: 4px; font-size: 12px; cursor: pointer;
    background: var(--bg-tertiary); border: 1px solid var(--border); color: #58a6ff;
    flex-shrink: 0;
  }
  .jump-btn:hover { background: var(--border); border-color: #58a6ff; }
  .no-issues { text-align: center; padding: 20px; color: var(--text-secondary); font-size: 13px; }
</style>
