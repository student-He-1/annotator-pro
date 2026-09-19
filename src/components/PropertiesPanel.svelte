<script lang="ts">
  import { t } from '$lib/i18n.svelte';
  import {
    ui, images, classes, classColors, getClassCounts,
    COLORS, getClassColor, getCurrentAnnotations, selectAnnotation, deleteAnnotation,
    pushHistory, showToast, batchDeleteAll, getActiveClass, setActiveClass, annotations, saveAnnotations,
  } from '$lib/state.svelte';
  import { render } from '$lib/canvas/engine.svelte';
  import type { ExportFormat, Annotation } from '$lib/types';
  import Icon from './Icon.svelte';

  interface Props {
    onExportCurrent: () => void;
    onBatchExport: () => void;
    onImportLabelme: (file: File) => void;
    onAddClass: (name: string) => void;
    onChangeClass: (id: number, newClass: string) => void;
    onSelectClassColor: (className: string) => void;
    onClose: () => void;
  }
  let props: Props = $props();

  let newClass = $state('');
  let labelmeInput: HTMLInputElement | null = $state(null);

  const formats: { value: ExportFormat; label: string }[] = [
    { value: 'voc', label: 'PASCAL VOC XML' },
    { value: 'yolo', label: 'YOLO TXT' },
    { value: 'coco', label: 'COCO JSON (单文件)' },
    { value: 'coco_merged', label: 'COCO JSON (合并)' },
    { value: 'createml', label: 'CreateML JSON' },
    { value: 'labelme', label: 'LabelMe JSON' },
    { value: 'png', label: 'PNG 可视化图片' },
    { value: 'jpg', label: 'JPG 可视化图片' },
  ];

  function toggleImageLabel(className: string) {
    if (ui.currentImageIndex < 0) return;
    const imgName = images[ui.currentImageIndex].name;
    if (!ui.imageLabels[imgName]) ui.imageLabels[imgName] = [];
    const labels = ui.imageLabels[imgName];
    const idx = labels.indexOf(className);
    if (idx >= 0) {
      labels.splice(idx, 1);
    } else {
      labels.push(className);
    }
    pushHistory();
    saveAnnotations();
  }

  function handleAddClass() {
    const name = newClass.trim();
    if (!name) return;
    props.onAddClass(name);
    newClass = '';
  }

  function handleDeleteClass(className: string) {
    if (classes.length <= 1) { showToast('至少保留一个类别', 'error'); return; }
    if (!confirm(`确定要删除类别 ${className} 吗？相关标注将保留但类别会改为第一个类别。`)) return;
    
    // 删除类别
    const idx = classes.indexOf(className);
    if (idx >= 0) classes.splice(idx, 1);
    
    // 更新所有标注的类别
    const newDefault = classes[0];
    for (const name of Object.keys(annotations)) {
      for (const ann of annotations[name]) {
        if (ann.className === className) ann.className = newDefault;
      }
    }
    
    // 如果删除的是当前激活类别，切换到第一个
    if (getActiveClass() === className) setActiveClass(newDefault);
    
    pushHistory();
    showToast(`已删除类别 ${className}`, 'success');
  }

  function getTypeIcon(ann: Annotation): string {
    switch (ann.type) {
      case 'rect': return '▭';
      case 'polygon': return '⬠';
      case 'rotated': return '◇';
      case 'keypoint': return '⊕';
      default: return '?';
    }
  }

  function handleDeleteAnn(ann: Annotation) {
    deleteAnnotation(ann);
    pushHistory();
    render();
    showToast(t('annotationDeleted'), 'info');
  }

  function handleClearAll() {
    const count = getCurrentAnnotations().length;
    if (count === 0) return;
    if (!confirm(`确定要清除当前图片的 ${count} 个标注吗？此操作可撤销。`)) return;
    batchDeleteAll('current');
    render();
    showToast(`已清除 ${count} 个标注，可按 Ctrl+Z 撤销`, 'success');
  }
</script>

<div class="props-panel">
  <div class="props-header">
    <h3>{t('properties')}</h3>
    <button class="close-btn" onclick={props.onClose} title="关闭属性面板">×</button>
  </div>
  <div class="props-content">
    <!-- 图像分类模式 -->
    {#if ui.workMode === 'classification'}
      <div class="section">
        <h4>图片分类标签</h4>
        <p class="muted">为当前图片选择类别标签</p>
        <div class="class-list">
          {#each classes as c, i}
            {@const isSelected = (ui.imageLabels[images[ui.currentImageIndex]?.name] || []).includes(c)}
            <div class="class-item" class:selected={isSelected}
              onclick={() => toggleImageLabel(c)}>
              <span class="class-color" style="background:{getClassColor(c)}"></span>
              <span class="class-name">{c}</span>
              {#if isSelected}<span class="check">✓</span>{/if}
              <button class="class-delete" onclick={(e) => { e.stopPropagation(); handleDeleteClass(c); }} title="删除类别">×</button>
            </div>
          {/each}
        </div>
        <div class="class-input-row">
          <input type="text" placeholder="添加新类别..." bind:value={newClass}
            onkeydown={(e) => { if (e.key === 'Enter') handleAddClass(); }}>
          <button onclick={handleAddClass}>+</button>
        </div>
      </div>
    {:else}
    <!-- Annotation Info -->
    <div class="section">
      <h4>{t('annotationInfo')}</h4>
      {#if ui.selectedAnnotation}
        {@const ann = ui.selectedAnnotation}
        <div class="row"><label>{t('id')}</label><span>{ann.id}</span></div>
        <div class="row"><label>{t('type')}</label><span>{ann.type}</span></div>
        <div class="row"><label>{t('label')}</label>
          <select value={ann.className} onchange={(e) => props.onChangeClass(ann.id, (e.target as HTMLSelectElement).value)}>
            {#each classes as c}
              <option value={c} selected={ann.className === c}>{c}</option>
            {/each}
          </select>
        </div>
        {#if ann.type === 'rect'}
          <div class="row"><label>X</label><span>{ann.x.toFixed(1)}</span></div>
          <div class="row"><label>Y</label><span>{ann.y.toFixed(1)}</span></div>
          <div class="row"><label>W</label><span>{ann.w.toFixed(1)}</span></div>
          <div class="row"><label>H</label><span>{ann.h.toFixed(1)}</span></div>
        {:else if ann.type === 'rotated'}
          <div class="row"><label>CX</label><span>{ann.cx.toFixed(1)}</span></div>
          <div class="row"><label>CY</label><span>{ann.cy.toFixed(1)}</span></div>
          <div class="row"><label>W</label><span>{ann.w.toFixed(1)}</span></div>
          <div class="row"><label>H</label><span>{ann.h.toFixed(1)}</span></div>
          <div class="row"><label>Angle</label><span>{ann.angle.toFixed(1)}°</span></div>
        {:else if ann.type === 'polygon' || ann.type === 'keypoint'}
          <div class="row"><label>{t('coordinates')}</label><span>{ann.points.length} pts</span></div>
        {/if}
      {:else}
        <span class="muted">{t('selectHint')}</span>
      {/if}
    </div>

    <!-- Annotation List -->
    <div class="section">
      <div class="section-header">
        <h4>标注列表 ({getCurrentAnnotations().length})</h4>
        {#if getCurrentAnnotations().length > 0}
          <button class="clear-all-btn" title="清除当前图片所有标注" onclick={handleClearAll}>
            <Icon name="trash" size={12} />
            <span>清除</span>
          </button>
        {/if}
      </div>
      {#if getCurrentAnnotations().length === 0}
        <span class="muted">当前图片无标注</span>
      {:else}
        <div class="ann-list">
          {#each getCurrentAnnotations() as ann (ann.id)}
            <div class="ann-item" class:active={ui.selectedAnnotation?.id === ann.id}
              onclick={() => selectAnnotation(ann)}>
              <span class="ann-type" style="color:{getClassColor(ann.className)}">{getTypeIcon(ann)}</span>
              <span class="ann-class">{ann.className}</span>
              <span class="ann-id">#{ann.id}</span>
              {#if ann.trackId !== undefined}
                <span class="ann-track" title="追踪ID">T{ann.trackId}</span>
              {/if}
              <button class="ann-delete" title="删除" onclick={(e) => { e.stopPropagation(); handleDeleteAnn(ann); }}>×</button>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Class List -->
    <div class="section">
      <h4>{t('classList')}</h4>
      {#each classes as c, i}
        <div class="class-item" class:active={getActiveClass() === c} onclick={() => setActiveClass(c)}>
          <span class="class-color" style="background:{getClassColor(c)}"></span>
          <span class="class-name">{c}</span>
          <span class="class-count">{getClassCounts()[c] || 0}</span>
          <button class="class-delete" onclick={(e) => { e.stopPropagation(); handleDeleteClass(c); }} title="删除类别">×</button>
        </div>
      {/each}
      <div class="class-input-row">
        <input type="text" placeholder={t('addClassPlaceholder')} bind:value={newClass}
          onkeydown={(e) => { if (e.key === 'Enter') handleAddClass(); }}>
        <button onclick={handleAddClass}>+</button>
      </div>
    </div>

    <!-- Export -->
    <div class="section">
      <h4>{t('export')}</h4>
      <div class="export-format">
        <label>{t('chooseFormat')}</label>
        <select value={ui.exportFormat} onchange={(e) => ui.exportFormat = (e.target as HTMLSelectElement).value as ExportFormat}>
          {#each formats as f}
            <option value={f.value}>{f.label}</option>
          {/each}
        </select>
      </div>
      <div class="export-buttons">
        <button class="btn-sm btn-success" onclick={props.onExportCurrent}>{t('currentExport')}</button>
        <button class="btn-sm btn-primary" onclick={props.onBatchExport}>{t('batchExportBtn')}</button>
      </div>
      <div class="import-section">
        <input type="file" accept=".json" bind:this={labelmeInput} style="display:none"
          onchange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) props.onImportLabelme(f);
            (e.target as HTMLInputElement).value = '';
          }} />
        <button class="btn-sm btn-import" onclick={() => labelmeInput?.click()}>导入 LabelMe 标注</button>
      </div>
    </div>
    {/if}
  </div>
</div>

<style>
  .props-panel {
    width: 260px; min-width: 260px;
    background: var(--bg-secondary);
    border-left: 1px solid var(--border);
    display: flex; flex-direction: column;
    z-index: 10;
  }
  .props-header {
    padding: 14px 16px 12px;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between;
  }
  .props-header h3 {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    text-transform: uppercase;
    color: var(--text-secondary);
    letter-spacing: 0.8px;
  }
  .close-btn {
    background: none; border: none;
    color: var(--text-secondary);
    font-size: 18px; cursor: pointer;
    line-height: 1; padding: 2px 6px;
    border-radius: var(--radius-sm);
    transition: all var(--transition-fast);
  }
  .close-btn:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }
  .props-content {
    flex: 1; min-height: 0; overflow-y: auto;
    padding: 14px 14px;
  }
  .props-content::-webkit-scrollbar { width: 4px; }
  .props-content::-webkit-scrollbar-track { background: transparent; }
  .props-content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  .section { margin-bottom: 18px; }
  .section-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 10px; padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
  }
  .section-header h4 {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-muted);
    margin: 0;
    font-weight: var(--weight-semibold);
    border-bottom: none;
    padding-bottom: 0;
  }
  .clear-all-btn {
    display: flex; align-items: center; gap: 4px;
    padding: 3px 8px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 10px;
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .clear-all-btn:hover {
    color: var(--accent-red);
    border-color: var(--accent-red);
    background: rgba(220,38,38,0.08);
  }
  .row {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 8px; font-size: var(--text-sm);
  }
  .row label { color: var(--text-secondary); font-size: var(--text-xs); }
  .row select, .row input {
    width: 100px; padding: 5px 8px;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    transition: all var(--transition-fast);
  }
  .row select:focus, .row input:focus {
    border-color: var(--accent-blue);
    box-shadow: 0 0 0 2px rgba(77,163,255,0.15);
  }
  .muted { color: var(--text-muted); font-size: var(--text-sm); }

  .ann-list { max-height: 200px; overflow-y: auto; }
  .ann-list::-webkit-scrollbar { width: 3px; }
  .ann-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
  .ann-item {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px;
    border-radius: var(--radius-md);
    margin-bottom: 3px;
    font-size: var(--text-xs);
    cursor: pointer;
    transition: all var(--transition-fast);
    border: 1px solid transparent;
  }
  .ann-item:hover { background: var(--bg-tertiary); }
  .ann-item.active {
    background: rgba(77,163,255,0.1);
    border-color: rgba(77,163,255,0.3);
  }
  .ann-type { font-size: 14px; flex-shrink: 0; }
  .ann-class {
    flex: 1; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
    color: var(--text-primary);
    font-weight: var(--weight-medium);
  }
  .ann-id {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
  }
  .ann-track {
    font-size: 9px; padding: 2px 6px;
    border-radius: var(--radius-sm);
    background: rgba(74,222,128,0.15);
    color: var(--accent-green);
    font-family: var(--font-mono);
    font-weight: var(--weight-semibold);
  }
  .ann-delete {
    width: 20px; height: 20px;
    border: none; background: transparent;
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    cursor: pointer; font-size: 14px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    transition: all var(--transition-fast);
    opacity: 0;
  }
  .ann-item:hover .ann-delete { opacity: 1; }
  .ann-delete:hover {
    background: rgba(248,113,113,0.15);
    color: var(--accent-red);
  }

  .class-item {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 10px;
    border-radius: var(--radius-md);
    margin-bottom: 3px;
    font-size: var(--text-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .class-item:hover { background: var(--bg-tertiary); }
  .class-item.active { background: var(--bg-tertiary); box-shadow: inset 2px 0 0 var(--accent-blue); }
  .class-delete {
    width: 18px; height: 18px;
    border: none; background: transparent;
    color: var(--text-muted);
    font-size: 14px; line-height: 1;
    cursor: pointer; border-radius: 3px;
    display: flex; align-items: center; justify-content: center;
  }
  .class-delete:hover { color: var(--danger); background: rgba(248,81,73,0.1); }
  .class-item.selected { background: rgba(88,166,255,0.15); border: 1px solid var(--accent-blue); }
  .check { color: var(--accent-blue); font-weight: bold; }
  .class-color {
    width: 10px; height: 10px;
    border-radius: 3px;
    flex-shrink: 0;
    box-shadow: 0 0 0 1px rgba(255,255,255,0.1);
  }
  .class-name { flex: 1; font-weight: var(--weight-medium); }
  .class-count {
    font-size: 10px; color: var(--text-muted);
    font-family: var(--font-mono);
    background: var(--bg-tertiary);
    padding: 1px 6px;
    border-radius: 8px;
  }
  .class-input-row {
    display: flex; gap: 6px; margin-top: 10px;
  }
  .class-input-row input {
    flex: 1; padding: 6px 10px;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-xs);
    transition: all var(--transition-fast);
  }
  .class-input-row input:focus {
    outline: none;
    border-color: var(--accent-blue);
    box-shadow: 0 0 0 2px rgba(77,163,255,0.15);
  }
  .class-input-row button {
    padding: 6px 12px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    transition: all var(--transition-fast);
  }
  .class-input-row button:hover {
    background: var(--accent-blue);
    color: #fff;
    border-color: var(--accent-blue);
  }

  .export-format { margin-bottom: 10px; }
  .export-format label {
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    font-weight: var(--weight-semibold);
  }
  .export-format select {
    width: 100%; margin-top: 6px;
    padding: 7px 10px;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-xs);
    transition: all var(--transition-fast);
    cursor: pointer;
  }
  .export-format select:focus {
    border-color: var(--accent-blue);
    box-shadow: 0 0 0 2px rgba(77,163,255,0.15);
  }
  .export-buttons { display: flex; flex-direction: column; gap: 6px; }
  .btn-sm {
    padding: 8px 14px;
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    border: 1px solid var(--border);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    text-align: center;
    letter-spacing: 0.3px;
  }
  .btn-sm:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    transform: translateY(-1px);
  }
  .btn-sm:active { transform: translateY(0); }
  .btn-success {
    background: var(--accent-green);
    color: #0a0f0a;
    border-color: var(--accent-green);
  }
  .btn-success:hover {
    background: #5be896;
    border-color: #5be896;
    color: #0a0f0a;
  }
  .btn-primary {
    background: var(--accent-blue);
    color: #fff;
    border-color: var(--accent-blue);
  }
  .btn-primary:hover {
    background: #6bb3ff;
    border-color: #6bb3ff;
    color: #fff;
  }
  .import-section { margin-top: 8px; }
  .btn-import {
    width: 100%;
    background: transparent;
    color: var(--accent-orange);
    border-color: rgba(251,191,36,0.4);
  }
  .btn-import:hover {
    background: rgba(251,191,36,0.1);
    color: var(--accent-orange);
    border-color: var(--accent-orange);
  }
</style>

















