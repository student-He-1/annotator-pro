<script lang="ts">
  import { images, showToast } from '$lib/state.svelte';
  import { runImageQualityCheck, DEFAULT_IMAGE_QUALITY_CONFIG } from '$lib/imageQuality';
  import type { ImageQualityReport, ImageQualityIssue, ImageQualityConfig } from '$lib/imageQuality';

  interface Props {
    onClose: () => void;
    onJumpToImage: (imageName: string) => void;
  }
  let { onClose, onJumpToImage }: Props = $props();

  // 配置
  let blurThreshold = $state(DEFAULT_IMAGE_QUALITY_CONFIG.blurThreshold);
  let darkThreshold = $state(DEFAULT_IMAGE_QUALITY_CONFIG.darkThreshold);
  let brightThreshold = $state(DEFAULT_IMAGE_QUALITY_CONFIG.brightThreshold);
  let duplicateThreshold = $state(DEFAULT_IMAGE_QUALITY_CONFIG.duplicateThreshold);
  let checkBlur = $state(true);
  let checkBrightness = $state(true);
  let checkDuplicate = $state(true);

  let report = $state<ImageQualityReport | null>(null);
  let checking = $state(false);
  let checkProgress = $state(0);
  let filterType = $state<string>('all');

  const filteredIssues = $derived.by(() => {
    if (!report) return [];
    if (filterType === 'all') return report.issues;
    if (filterType === 'error') return report.issues.filter(i => i.severity === 'error');
    if (filterType === 'warning') return report.issues.filter(i => i.severity === 'warning');
    return report.issues.filter(i => i.type === filterType);
  });

  const issueTypeLabels: Record<string, string> = {
    blur: '模糊',
    too_dark: '过暗',
    too_bright: '过亮',
    duplicate: '重复/相似',
  };

  const issueTypeColors: Record<string, string> = {
    blur: '#f85149',
    too_dark: '#58a6ff',
    too_bright: '#d2991d',
    duplicate: '#bc8cff',
  };

  async function handleCheck() {
    if (images.length === 0) {
      showToast('请先导入图片', 'error');
      return;
    }
    checking = true;
    checkProgress = 0;
    report = null;

    const config: ImageQualityConfig = {
      blurThreshold, darkThreshold, brightThreshold, duplicateThreshold,
      checkBlur, checkBrightness, checkDuplicate,
    };

    try {
      // 用 setTimeout 让 UI 先更新
      await new Promise(r => setTimeout(r, 50));
      const result = await runImageQualityCheck(images, config);
      report = result;
      if (result.passed) {
        showToast('图片质量检查通过！', 'success');
      } else {
        showToast(`发现 ${result.issues.length} 个图片质量问题`, 'error');
      }
    } catch (e) {
      showToast('检查失败：' + (e as Error).message, 'error');
    } finally {
      checking = false;
    }
  }

  function handleJump(issue: ImageQualityIssue) {
    onJumpToImage(issue.image);
  }

  function handleJumpDuplicate(issue: ImageQualityIssue) {
    if (issue.duplicateOf) onJumpToImage(issue.duplicateOf);
  }
</script>

<div class="modal-overlay" onclick={onClose}>
  <div class="modal" onclick={e => e.stopPropagation()}>
    <div class="modal-header">
      <h3>图片质量筛查</h3>
      <button class="close-btn" onclick={onClose}>×</button>
    </div>

    <div class="modal-body">
      <!-- 配置选项 -->
      <div class="section">
        <h4>检测项目</h4>
        <div class="options-grid">
          <label class="checkbox">
            <input type="checkbox" bind:checked={checkBlur} />
            模糊检测
          </label>
          <label class="checkbox">
            <input type="checkbox" bind:checked={checkBrightness} />
            过暗/过亮检测
          </label>
          <label class="checkbox">
            <input type="checkbox" bind:checked={checkDuplicate} />
            重复/相似图片
          </label>
        </div>

        <div class="params-grid">
          <div class="param-row">
            <label>模糊阈值（清晰度）</label>
            <input type="number" bind:value={blurThreshold} min="1" disabled={!checkBlur} />
          </div>
          <div class="param-row">
            <label>过暗阈值（0-255）</label>
            <input type="number" bind:value={darkThreshold} min="0" max="255" disabled={!checkBrightness} />
          </div>
          <div class="param-row">
            <label>过亮阈值（0-255）</label>
            <input type="number" bind:value={brightThreshold} min="0" max="255" disabled={!checkBrightness} />
          </div>
          <div class="param-row">
            <label>重复阈值（汉明距离）</label>
            <input type="number" bind:value={duplicateThreshold} min="0" max="64" disabled={!checkDuplicate} />
          </div>
        </div>
      </div>

      <!-- 运行按钮 -->
      <button class="btn primary" onclick={handleCheck} disabled={checking}>
        {checking ? '检测中...' : `开始检测（${images.length} 张图片）`}
      </button>

      <!-- 报告 -->
      {#if report}
        <div class="report-section">
          <div class="report-summary" class:passed={report.passed} class:failed={!report.passed}>
            <div class="summary-status">
              {report.passed ? '✓ 全部通过' : `✗ 发现 ${report.issues.length} 个问题`}
            </div>
            <div class="summary-stats">
              <span>共 {report.totalImages} 张</span>
              <span class="issue-count">{report.issues.length} 个问题</span>
            </div>
          </div>

          {#if report.issues.length > 0}
            <!-- 过滤栏 -->
            <div class="filter-bar">
              <button class="filter-btn" class:active={filterType === 'all'} onclick={() => filterType = 'all'}>
                全部 ({report.issues.length})
              </button>
              <button class="filter-btn" class:active={filterType === 'error'} onclick={() => filterType = 'error'}>
                严重 ({report.issues.filter(i => i.severity === 'error').length})
              </button>
              <button class="filter-btn" class:active={filterType === 'warning'} onclick={() => filterType = 'warning'}>
                警告 ({report.issues.filter(i => i.severity === 'warning').length})
              </button>
            </div>

            <div class="issue-type-bar">
              {#each Object.entries(report.issueCounts) as [type, count]}
                <button class="type-btn" class:active={filterType === type} onclick={() => filterType = type}
                  style="border-left-color: {issueTypeColors[type]}">
                  {issueTypeLabels[type] || type} ({count})
                </button>
              {/each}
            </div>

            <!-- 问题列表 -->
            <div class="issue-list">
              {#each filteredIssues as issue (issue.image + issue.type + (issue.duplicateOf || ''))}
                <div class="issue-item" class:error={issue.severity === 'error'}
                  style="border-left-color: {issueTypeColors[issue.type]}">
                  <div class="issue-icon" style="color: {issueTypeColors[issue.type]}">
                    {issue.severity === 'error' ? '✗' : '⚠'}
                  </div>
                  <div class="issue-content">
                    <div class="issue-message">{issue.message}</div>
                    <div class="issue-meta">
                      <span class="issue-type" style="color: {issueTypeColors[issue.type]}">
                        {issueTypeLabels[issue.type] || issue.type}
                      </span>
                      <span class="issue-image" title={issue.image}>{issue.image}</span>
                      {#if issue.duplicateOf}
                        <span class="duplicate-link" onclick={() => handleJumpDuplicate(issue)}
                          title="跳转到相似图片">
                          ↔ {issue.duplicateOf}
                        </span>
                      {/if}
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
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .modal {
    background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px;
    width: 600px; max-height: 85vh; overflow-y: auto; color: var(--text-primary);
  }
  .modal-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 14px 18px; border-bottom: 1px solid var(--border);
    position: sticky; top: 0; background: var(--bg-secondary); z-index: 1;
  }
  .modal-header h3 { margin: 0; font-size: 16px; }
  .close-btn {
    background: none; border: none; color: var(--text-secondary); font-size: 22px;
    cursor: pointer; padding: 0 4px;
  }
  .close-btn:hover { color: var(--text-primary); }
  .modal-body { padding: 16px 18px; }

  .section { margin-bottom: 16px; }
  .section h4 { margin: 0 0 10px; font-size: 13px; color: #58a6ff; }

  .options-grid {
    display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 12px;
  }
  .checkbox {
    display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-primary); cursor: pointer;
  }
  .checkbox input { cursor: pointer; }
  .checkbox input:disabled { opacity: 0.5; }

  .params-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
  }
  .param-row {
    display: flex; align-items: center; gap: 8px;
  }
  .param-row label { width: 130px; flex-shrink: 0; font-size: 11px; color: var(--text-secondary); }
  .param-row input {
    flex: 1; padding: 5px 8px; background: var(--bg-primary); border: 1px solid var(--border);
    border-radius: 4px; color: var(--text-primary); font-size: 12px; width: 60px;
  }
  .param-row input:disabled { opacity: 0.4; }

  .btn {
    padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500;
    cursor: pointer; border: none; transition: background 0.15s; width: 100%;
  }
  .btn.primary { background: #238636; color: #fff; }
  .btn.primary:hover:not(:disabled) { background: #2ea043; }
  .btn:disabled { opacity: 0.6; cursor: not-allowed; }

  .report-section { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
  .report-summary {
    padding: 14px; border-radius: 6px; margin-bottom: 14px;
  }
  .report-summary.passed { background: rgba(35,134,54,0.12); border: 1px solid #238636; }
  .report-summary.failed { background: rgba(248,81,73,0.12); border: 1px solid #f85149; }
  .summary-status { font-size: 16px; font-weight: 600; margin-bottom: 6px; }
  .passed .summary-status { color: #3fb950; }
  .failed .summary-status { color: #f85149; }
  .summary-stats { display: flex; gap: 16px; font-size: 12px; color: var(--text-secondary); }
  .issue-count { color: #f85149; font-weight: 600; }

  .filter-bar { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
  .filter-btn {
    padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer;
    background: var(--bg-tertiary); border: 1px solid var(--border); color: var(--text-secondary);
  }
  .filter-btn:hover { border-color: var(--text-secondary); color: var(--text-primary); }
  .filter-btn.active { background: #1f6feb; border-color: #1f6feb; color: #fff; }

  .issue-type-bar { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
  .type-btn {
    padding: 3px 8px; border-radius: 3px; font-size: 11px; cursor: pointer;
    background: transparent; border: 1px solid var(--border); border-left-width: 3px;
    color: var(--text-secondary);
  }
  .type-btn:hover { border-color: var(--text-secondary); }
  .type-btn.active { background: var(--border); color: var(--text-primary); }

  .issue-list { max-height: 320px; overflow-y: auto; }
  .issue-item {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border-radius: 4px; margin-bottom: 6px; background: var(--bg-primary);
    border-left: 3px solid var(--border);
  }
  .issue-icon {
    width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
    border-radius: 50%; font-size: 12px; flex-shrink: 0; font-weight: 700;
  }
  .issue-content { flex: 1; min-width: 0; }
  .issue-message { font-size: 12px; color: var(--text-primary); margin-bottom: 2px; }
  .issue-meta { display: flex; gap: 10px; font-size: 10px; color: var(--text-secondary); align-items: center; flex-wrap: wrap; }
  .issue-type { text-transform: uppercase; font-weight: 600; }
  .issue-image { font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
  .duplicate-link { color: #58a6ff; cursor: pointer; text-decoration: underline; }
  .duplicate-link:hover { color: #79c0ff; }
  .jump-btn {
    padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer;
    background: var(--bg-tertiary); border: 1px solid var(--border); color: #58a6ff; flex-shrink: 0;
  }
  .jump-btn:hover { background: var(--border); border-color: #58a6ff; }
  .no-issues { text-align: center; padding: 16px; color: var(--text-secondary); font-size: 12px; }
</style>
