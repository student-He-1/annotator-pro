<script lang="ts">
  import { images, classes, showToast, ui, saveAnnotations, pushHistory, captureUndoBaseline, imageModified, annotations } from '$lib/state.svelte';
  import { batchChangeClass, batchDeleteClass, batchDeleteAll, copyToAllSubsequent, copyCurrentToRange } from '$lib/state.svelte';

  interface Props {
    onClose: () => void;
    onRefresh: () => void;
  }
  let { onClose, onRefresh }: Props = $props();

  let activeTab = $state<'change' | 'delete' | 'copy'>('change');

  // 分类模式：图片范围选择
  let rangeStart = $state(1);
  let rangeEnd = $state(images.length);
  let batchLabel = $state('');

  // 批量改类别
  let changeOldClass = $state('');
  let changeNewClass = $state('');
  let changeScope = $state<'all' | 'current' | 'range'>('all');

  // 批量删除
  let deleteClass = $state('');
  let deleteScope = $state<'all' | 'current' | 'range'>('all');
  let deleteAll = $state(false);

  // 批量复制到指定范围（1 起闭区间）
  let copyStart = $state(Math.min(images.length, ui.currentImageIndex + 2));
  let copyEnd = $state(images.length);

  function getCurrentImageName(): string {
    return ui.currentImageIndex >= 0 && images[ui.currentImageIndex] ? images[ui.currentImageIndex].name : '';
  }

  /** 作用范围的中文描述，用于确认弹窗文案 */
  function scopeLabel(scope: 'all' | 'current' | 'range'): string {
    if (scope === 'range') return `第 ${rangeStart}-${rangeEnd} 张`;
    return scope === 'all' ? '所有图片' : '当前图片';
  }

  function handleChangeClass() {
    if (!changeOldClass || !changeNewClass) {
      showToast('请选择原类别和新类别', 'error');
      return;
    }
    if (changeOldClass === changeNewClass) {
      showToast('原类别和新类别不能相同', 'error');
      return;
    }
    const count = batchChangeClass(changeOldClass, changeNewClass, changeScope, rangeStart, rangeEnd);
    if (count > 0) {
      showToast(`已将 ${count} 个标注从 "${changeOldClass}" 改为 "${changeNewClass}"`, 'success');
      onRefresh();
    } else {
      showToast('没有找到匹配的标注', 'info');
    }
  }

  function handleDelete() {
    let count = 0;
    if (deleteAll) {
      if (!confirm(`确定要删除${scopeLabel(deleteScope)}的全部标注吗？此操作不可撤销。`)) return;
      count = batchDeleteAll(deleteScope, rangeStart, rangeEnd);
    } else {
      if (!deleteClass) {
        showToast('请选择要删除的类别', 'error');
        return;
      }
      if (!confirm(`确定要删除${scopeLabel(deleteScope)}中所有 "${deleteClass}" 类别的标注吗？`)) return;
      count = batchDeleteClass(deleteClass, deleteScope, rangeStart, rangeEnd);
    }
    if (count > 0) {
      showToast(`已删除 ${count} 个标注`, 'success');
      onRefresh();
    } else {
      showToast('没有找到匹配的标注', 'info');
    }
  }

  // 分类模式：自动识别已打标签的范围
  const labelRanges = $derived.by(() => {
    if (ui.workMode !== 'classification') return [];
    const ranges: { label: string; start: number; end: number; count: number }[] = [];
    for (const cls of classes) {
      const indices: number[] = [];
      images.forEach((img, i) => {
        if ((ui.imageLabels[img.name] || []).includes(cls)) {
          indices.push(i);
        }
      });
      if (indices.length > 0) {
        ranges.push({
          label: cls,
          start: indices[0] + 1,
          end: indices[indices.length - 1] + 1,
          count: indices.length
        });
      }
    }
    return ranges;
  });

  // 分类模式：批量删除标签
  function handleBatchDeleteLabel() {
    if (!deleteClass) {
      showToast('请选择要删除的标签', 'error');
      return;
    }
    const start = Math.max(0, rangeStart - 1);
    const end = Math.min(images.length, rangeEnd);
    let count = 0;
    const changed: string[] = [];
    for (let i = start; i < end; i++) {
      const imgName = images[i].name;
      captureUndoBaseline(imgName);   // 批量前先补基线，撤销到底才不会清空
      if (ui.imageLabels[imgName]) {
        const before = ui.imageLabels[imgName].length;
        ui.imageLabels[imgName] = ui.imageLabels[imgName].filter(l => l !== deleteClass);
        const removed = before - ui.imageLabels[imgName].length;
        if (removed > 0) changed.push(imgName);
        count += removed;
      }
    }
    if (count > 0) {
      showToast('已删除 ' + count + ' 个标签', 'success');
      // 每张被改的图都要置脏。不能用 markModified()：它只标「当前图片」，
      // 批量改的往往不是当前这张 → 状态栏永远显示「已保存」（等价于谎报已存）。
      for (const n of changed) imageModified[n] = true;
      pushHistory(changed);   // 一次批量整体进一条历史，Ctrl+Z 能整体还原
      saveAnnotations();
      onRefresh();
    } else {
      showToast('没有找到匹配的标签', 'info');
    }
  }

  // 分类模式：批量打标签
  function handleBatchLabel() {
    if (!batchLabel) {
      showToast('请选择类别', 'error');
      return;
    }
    const start = Math.max(0, rangeStart - 1);
    const end = Math.min(images.length, rangeEnd);
    let count = 0;
    const changed: string[] = [];
    for (let i = start; i < end; i++) {
      const imgName = images[i].name;
      captureUndoBaseline(imgName);   // 批量前先补基线，撤销到底才不会清空
      if (!ui.imageLabels[imgName]) ui.imageLabels[imgName] = [];
      if (!ui.imageLabels[imgName].includes(batchLabel)) {
        ui.imageLabels[imgName].push(batchLabel);
        count++;
        changed.push(imgName);
      }
    }
    if (count > 0) {
      showToast('已为 ' + count + ' 张图片打上标签', 'success');
      // 同 handleBatchDeleteLabel：逐张置脏，否则状态栏一直显示「已保存」
      for (const n of changed) imageModified[n] = true;
      pushHistory(changed);   // 一次批量整体进一条历史，Ctrl+Z 能整体还原
      saveAnnotations();
      onRefresh();
    } else {
      showToast('没有需要打标的图片', 'info');
    }
  }

  function handleCopyToAll() {
    if (ui.currentImageIndex < 0) {
      showToast('请先选择图片', 'error');
      return;
    }
    if (ui.currentImageIndex >= images.length - 1) {
      showToast('当前已是最后一张图片', 'info');
      return;
    }
    const count = copyToAllSubsequent();
    if (count > 0) {
      showToast(`已复制 ${count} 个标注到后续 ${images.length - ui.currentImageIndex - 1} 张图片`, 'success');
      onRefresh();
    } else {
      showToast('当前图片没有标注', 'info');
    }
  }

  function handleCopyToRange() {
    if (ui.currentImageIndex < 0) {
      showToast('请先选择图片', 'error');
      return;
    }
    const res = copyCurrentToRange(copyStart, copyEnd);
    if (res.copied === 0) {
      const reasons: string[] = [];
      if (res.skippedSize > 0) reasons.push(`${res.skippedSize} 张尺寸不一致`);
      if (res.skippedExisting > 0) reasons.push(`${res.skippedExisting} 张已有标注`);
      if (res.skippedCurrent > 0) reasons.push('范围包含当前图');
      showToast(reasons.length > 0 ? `没有复制：${reasons.join('，')}` : '当前图片没有标注或范围为空', 'info');
      return;
    }
    const skipped: string[] = [];
    if (res.skippedSize > 0) skipped.push(`跳过 ${res.skippedSize} 张尺寸不一致`);
    if (res.skippedExisting > 0) skipped.push(`跳过 ${res.skippedExisting} 张已有标注`);
    showToast(
      `已复制 ${res.copied} 个标注到 ${res.images} 张图片` +
      (skipped.length > 0 ? `（${skipped.join('，')}）` : ''),
      'success',
    );
    onRefresh();
  }
</script>

<div class="modal-overlay" role="presentation" onclick={onClose}>
  <div class="modal" role="presentation" onclick={e => e.stopPropagation()}>
    <div class="modal-header">
      <h3>批量操作</h3>
      <button class="close-btn" onclick={onClose}>×</button>
    </div>

    <div class="modal-body">
      <!-- 标签页 -->
      <div class="tabs">
        {#if ui.workMode === 'classification'}
          <button class="tab" class:active={activeTab === 'change'} onclick={() => activeTab = 'change'}>
            批量打标签
          </button>
          <button class="tab" class:active={activeTab === 'delete'} onclick={() => activeTab = 'delete'}>
            批量删除标签
          </button>
        {:else}
          <button class="tab" class:active={activeTab === 'change'} onclick={() => activeTab = 'change'}>
            批量改类别
          </button>
          <button class="tab" class:active={activeTab === 'delete'} onclick={() => activeTab = 'delete'}>
            批量删除
          </button>
          <button class="tab" class:active={activeTab === 'copy'} onclick={() => activeTab = 'copy'}>
            批量复制
          </button>
        {/if}
      </div>

      <!-- 批量打标签 / 批量改类别 -->
      {#if activeTab === 'change'}
        {#if ui.workMode === 'classification'}
          <div class="tab-content">
            <div class="form-row">
              <label for="batch-label">选择标签</label>
              <select id="batch-label" bind:value={batchLabel}>
                <option value="">选择类别...</option>
                {#each classes as cls}
                  <option value={cls}>{cls}</option>
                {/each}
              </select>
            </div>
            <div class="form-row">
              <span>图片范围</span>
              <div style="display:flex;gap:8px;align-items:center">
                <span>第</span>
                <input type="number" bind:value={rangeStart} min="1" max={images.length} style="width:60px" />
                <span>到</span>
                <input type="number" bind:value={rangeEnd} min="1" max={images.length} style="width:60px" />
                <span>张 (共 {images.length} 张)</span>
              </div>
            </div>
            <button class="btn primary" onclick={handleBatchLabel}>批量打标签</button>
          </div>
        {:else}
          <div class="tab-content">
            <div class="form-row">
              <label for="batch-old-class">原类别</label>
              <select id="batch-old-class" bind:value={changeOldClass}>
                <option value="">选择类别...</option>
                {#each classes as cls}
                  <option value={cls}>{cls}</option>
                {/each}
              </select>
            </div>
            <div class="form-row">
              <label for="batch-new-class">新类别</label>
              <select id="batch-new-class" bind:value={changeNewClass}>
                <option value="">选择类别...</option>
                {#each classes as cls}
                  <option value={cls}>{cls}</option>
                {/each}
              </select>
            </div>
            <div class="form-row">
              <span>操作范围</span>
              <div class="radio-group">
                <label class="radio">
                  <input type="radio" bind:group={changeScope} value="all" />
                  所有图片 ({images.length} 张)
                </label>
                <label class="radio">
                  <input type="radio" bind:group={changeScope} value="current" />
                  当前图片 ({getCurrentImageName() || '未选择'})
                </label>
                <label class="radio">
                  <input type="radio" bind:group={changeScope} value="range" />
                  图片范围
                </label>
              </div>
            </div>
            {#if changeScope === 'range'}
              <div class="form-row">
                <span>图片范围</span>
                <div style="display:flex;gap:8px;align-items:center">
                  <span>第</span>
                  <input type="number" bind:value={rangeStart} min="1" max={images.length} style="width:60px" />
                  <span>到</span>
                  <input type="number" bind:value={rangeEnd} min="1" max={images.length} style="width:60px" />
                  <span>张 (共 {images.length} 张)</span>
                </div>
              </div>
            {/if}
            <button class="btn primary" onclick={handleChangeClass}>执行改类别</button>
          </div>
        {/if}
      {/if}

      <!-- 批量删除标签 / 批量删除 -->
      {#if activeTab === 'delete'}
        {#if ui.workMode === 'classification'}
          <div class="tab-content">
            <div class="form-row">
              <label for="batch-del-label">删除标签</label>
              <select id="batch-del-label" bind:value={deleteClass}>
                <option value="">选择类别...</option>
                {#each classes as cls}
                  <option value={cls}>{cls}</option>
                {/each}
              </select>
            </div>
            {#if labelRanges.length > 0}
              <div class="form-row">
                <span>已打标范围（自动识别）</span>
                <div style="display:flex;flex-direction:column;gap:4px">
                  {#each labelRanges as r}
                    <button class="range-btn" onclick={() => { rangeStart = r.start; rangeEnd = r.end; deleteClass = r.label; }}>
                      {r.label}: 第 {r.start}-{r.end} 张 ({r.count} 张)
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
            <div class="form-row">
              <span>图片范围（手动选择）</span>
              <div style="display:flex;gap:8px;align-items:center">
                <span>第</span>
                <input type="number" bind:value={rangeStart} min="1" max={images.length} style="width:60px" />
                <span>到</span>
                <input type="number" bind:value={rangeEnd} min="1" max={images.length} style="width:60px" />
                <span>张 (共 {images.length} 张)</span>
              </div>
            </div>
            <div class="warning-box">
              ⚠ 删除操作不可撤销，请确认后执行
            </div>
            <button class="btn danger" onclick={handleBatchDeleteLabel}>批量删除标签</button>
          </div>
        {:else}
          <div class="tab-content">
            <div class="form-row">
              <label class="checkbox">
                <input type="checkbox" bind:checked={deleteAll} />
                删除所有类别（全部标注）
              </label>
            </div>
            {#if !deleteAll}
              <div class="form-row">
                <label for="batch-del-class">删除类别</label>
                <select id="batch-del-class" bind:value={deleteClass}>
                  <option value="">选择类别...</option>
                  {#each classes as cls}
                    <option value={cls}>{cls}</option>
                  {/each}
                </select>
              </div>
            {/if}
            <div class="form-row">
              <span>操作范围</span>
              <div class="radio-group">
                <label class="radio">
                  <input type="radio" bind:group={deleteScope} value="all" />
                  所有图片 ({images.length} 张)
                </label>
                <label class="radio">
                  <input type="radio" bind:group={deleteScope} value="current" />
                  当前图片 ({getCurrentImageName() || '未选择'})
                </label>
                <label class="radio">
                  <input type="radio" bind:group={deleteScope} value="range" />
                  图片范围
                </label>
              </div>
            </div>
            {#if deleteScope === 'range'}
              <div class="form-row">
                <span>图片范围</span>
                <div style="display:flex;gap:8px;align-items:center">
                  <span>第</span>
                  <input type="number" bind:value={rangeStart} min="1" max={images.length} style="width:60px" />
                  <span>到</span>
                  <input type="number" bind:value={rangeEnd} min="1" max={images.length} style="width:60px" />
                  <span>张 (共 {images.length} 张)</span>
                </div>
              </div>
            {/if}
            <div class="warning-box">
              ⚠ 删除操作不可撤销，请确认后执行
            </div>
            <button class="btn danger" onclick={handleDelete}>执行删除</button>
          </div>
        {/if}
      {/if}

      <!-- 批量复制 -->
      {#if activeTab === 'copy'}
        <div class="tab-content">
          <div class="info-box">
            <p><strong>当前图片：</strong>{getCurrentImageName() || '未选择'}</p>
            <p><strong>当前图标注：</strong>{(annotations[getCurrentImageName()] || []).length} 个</p>
            <p><strong>后续图片：</strong>{ui.currentImageIndex >= 0 ? Math.max(0, images.length - ui.currentImageIndex - 1) : 0} 张</p>
          </div>

          <p class="desc">追加复制到后续每一张图片（目标已有标注会叠加）。适用于视频帧序列或相似图片的快速标注。</p>
          <button class="btn primary" onclick={handleCopyToAll}>
            复制到所有后续图片
          </button>

          <div class="divider">或</div>

          <div class="form-row">
            <span>复制到指定范围（第 X~Y 张）</span>
            <div style="display:flex;gap:8px;align-items:center">
              <span>第</span>
              <input type="number" bind:value={copyStart} min="1" max={images.length} style="width:60px" />
              <span>到</span>
              <input type="number" bind:value={copyEnd} min="1" max={images.length} style="width:60px" />
              <span>张 (共 {images.length} 张)</span>
            </div>
          </div>
          <p class="desc">
            只复制到尺寸与当前图一致、且还没有标注的图片；当前图会跳过。
            尺寸不一致的图不会复制（坐标会错位），已有标注的图也不会覆盖。整批只占一个 <kbd>Ctrl</kbd>+<kbd>Z</kbd>。
          </p>
          <button class="btn primary" onclick={handleCopyToRange}>
            复制到指定范围
          </button>

          <div class="divider">或</div>

          <p class="desc">使用快捷键 <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>D</kbd> 复制到下一张图片。</p>
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

  .tabs {
    display: flex; gap: 4px; margin-bottom: 16px;
    border-bottom: 1px solid var(--border); padding-bottom: 0;
  }
  .tab {
    padding: 8px 16px; background: none; border: none; color: var(--text-secondary);
    font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tab:hover { color: var(--text-primary); }
  .tab.active { color: #58a6ff; border-bottom-color: #58a6ff; }

  .tab-content { display: flex; flex-direction: column; gap: 14px; }

  .form-row {
    display: flex; flex-direction: column; gap: 6px;
  }
  .form-row > label, .form-row > span {
    font-size: 12px; color: var(--text-secondary); font-weight: 500;
  }
  .form-row select, .form-row input {
    padding: 7px 10px; background: var(--bg-primary); border: 1px solid var(--border);
    border-radius: 4px; color: var(--text-primary); font-size: 13px;
  }
  .form-row select:focus, .form-row input:focus {
    outline: none; border-color: #58a6ff;
  }

  .radio-group { display: flex; flex-direction: column; gap: 6px; }
  .radio {
    display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-primary);
    cursor: pointer;
  }
  .radio input { cursor: pointer; }

  .checkbox {
    display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-primary);
    cursor: pointer;
  }
  .checkbox input { cursor: pointer; }

  .btn {
    padding: 9px 16px; border-radius: 6px; font-size: 13px; font-weight: 500;
    cursor: pointer; border: none; transition: background 0.15s; width: 100%;
  }
  .range-btn {
    padding: 6px 12px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-sm);
    cursor: pointer;
    text-align: left;
  }
  .range-btn:hover {
    border-color: var(--accent-blue);
    background: rgba(88,166,255,0.1);
  }
  .btn.primary { background: #238636; color: #fff; }
  .btn.primary:hover { background: #2ea043; }
  .btn.danger { background: #da3633; color: #fff; }
  .btn.danger:hover { background: #f85149; }

  .warning-box {
    padding: 10px 12px; background: rgba(210,153,29,0.1); border: 1px solid #d2991d;
    border-radius: 4px; font-size: 12px; color: #d2991d;
  }

  .info-box {
    padding: 12px; background: var(--bg-primary); border: 1px solid var(--border);
    border-radius: 6px; font-size: 13px;
  }
  .info-box p { margin: 4px 0; }
  .info-box strong { color: #58a6ff; }

  .desc { font-size: 12px; color: var(--text-secondary); line-height: 1.5; margin: 0; }

  .divider {
    text-align: center; color: var(--text-secondary); font-size: 12px;
    position: relative; margin: 4px 0;
  }
  .divider::before, .divider::after {
    content: ''; position: absolute; top: 50%; width: 40%; height: 1px; background: var(--border);
  }
  .divider::before { left: 0; }
  .divider::after { right: 0; }

  kbd {
    background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 3px;
    padding: 1px 6px; font-size: 11px; font-family: monospace; color: var(--text-primary);
  }
</style>















