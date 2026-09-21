<script lang="ts">
  import { t } from '$lib/i18n.svelte';
  import {
    ui, images, classes, classColors, getClassCounts,
    COLORS, getClassColor, getCurrentAnnotations, selectAnnotation, deleteAnnotation,
    pushHistory, showToast, batchDeleteAll, getActiveClass, setActiveClass, annotations, saveAnnotations,
    getNextAnnotationId, addAnnotation,
  } from '$lib/state.svelte';
  import { render } from '$lib/canvas/engine.svelte';
  import type { ExportFormat, Annotation } from '$lib/types';
  import Icon from './Icon.svelte';
  import { segmentByText, isModelLoaded, clearCache as clearSamCache, poseDetect, faceDetect, batchPcs, batchKp } from '$lib/sam';
  import type { PcsInstance } from '$lib/sam';

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
    { value: 'unet_mask', label: 'U-Net Mask (PNG)' },
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

  // ====== PCS 文本提示分割（侧边栏，仅 SAM 工具时显示）======
  let pcsText = $state('');
  let pcsThreshold = $state(0.5);
  let pcsRunning = $state(false);
  let pcsResults = $state<PcsInstance[]>([]);
  let pcsElapsed = $state(0);

  async function handlePcsDetect() {
    if (!ui.currentImage) { showToast('未加载图片', 'error'); return; }
    if (!isModelLoaded()) { showToast('SAM 模型未加载，请先在弹窗中加载', 'error'); return; }
    if (!pcsText.trim()) { showToast('请输入要检测的文本', 'error'); return; }
    try {
      pcsRunning = true;
      pcsResults = [];
      ui.samPcsPreview = null;
      const t0 = performance.now();
      const results = await segmentByText(ui.currentImage, pcsText, pcsThreshold);
      pcsElapsed = performance.now() - t0;
      pcsResults = results;
      if (results.length === 0) showToast(`未检测到 "${pcsText}"`, 'error');
      else showToast(`检测到 ${results.length} 个实例 (${(pcsElapsed/1000).toFixed(2)}s)`, 'success');
    } catch (e: any) {
      showToast(`文本分割失败: ${e.message || e}`, 'error');
    } finally {
      pcsRunning = false;
    }
  }

  function pcsAccept(idx: number) {
    const inst = pcsResults[idx];
    if (!inst || inst.polygon.length < 3) return;
    const ann: Annotation = {
      type: 'polygon',
      points: inst.polygon.map(p => ({ x: p.x, y: p.y })),
      className: getActiveClass(),
      id: getNextAnnotationId(),
    };
    addAnnotation(ann);
    pushHistory();
    selectAnnotation(ann);
    pcsResults = pcsResults.filter((_, i) => i !== idx);
    ui.samPcsPreview = null;
    render();
    showToast(`已接受 (score=${inst.score.toFixed(3)})`, 'success');
  }

  function pcsDiscard(idx: number) {
    pcsResults = pcsResults.filter((_, i) => i !== idx);
    ui.samPcsPreview = null;
  }

  function pcsAcceptAll() {
    let count = 0;
    for (const inst of pcsResults) {
      if (inst.polygon.length < 3) continue;
      const ann: Annotation = {
        type: 'polygon',
        points: inst.polygon.map(p => ({ x: p.x, y: p.y })),
        className: getActiveClass(),
        id: getNextAnnotationId(),
      };
      addAnnotation(ann);
      count++;
    }
    pushHistory();
    pcsResults = [];
    ui.samPcsPreview = null;
    render();
    if (count > 0) showToast(`已全部接受 ${count} 个实例`, 'success');
  }

  function pcsHover(idx: number | null) {
    ui.samPcsPreview = idx === null ? null : { points: pcsResults[idx].polygon };
    render();
  }

  // ====== 姿态预标注（keypoint 工具时）======
  let poseRunning = $state(false);

  async function handlePoseDetect() {
    if (!ui.currentImage) { showToast('未加载图片', 'error'); return; }
    try {
      poseRunning = true;
      const t0 = performance.now();
      const persons = await poseDetect(ui.currentImage, 0.25);
      const elapsed = (performance.now() - t0) / 1000;
      if (persons.length === 0) {
        const tryFace = window.confirm('未检测到人体。\n是否要改用 68 点人脸检测？');
        if (tryFace) await handleFaceDetect();
        return;
      }
      // 自动切到 COCO 17 点骨架模板
      ui.skeletonId = 'coco_body';
      let count = 0;
      for (const p of persons) {
        const ann: Annotation = {
          type: 'keypoint',
          points: p.keypoints.map(k => ({ x: k.x, y: k.y })),
          className: getActiveClass(),
          id: getNextAnnotationId(),
        };
        addAnnotation(ann);
        count++;
      }
      pushHistory();
      render();
      showToast(`姿态预标注: ${count} 个人 (${elapsed.toFixed(2)}s)`, 'success');
    } catch (e: any) {
      showToast(`姿态检测失败: ${e.message || e}`, 'error');
    } finally {
      poseRunning = false;
    }
  }

  // 人脸 68 点
  let faceRunning = $state(false);
  async function handleFaceDetect() {
    if (!ui.currentImage) { showToast('未加载图片', 'error'); return; }
    try {
      faceRunning = true;
      const t0 = performance.now();
      const faces = await faceDetect(ui.currentImage);
      const elapsed = (performance.now() - t0) / 1000;
      if (faces.length === 0) {
        const tryPose = window.confirm('未检测到人脸。\n是否要改用 17 点人体检测？');
        if (tryPose) await handlePoseDetect();
        return;
      }
      ui.skeletonId = 'face_68';
      for (const f of faces) {
        const ann: Annotation = {
          type: 'keypoint',
          points: f.keypoints,
          className: getActiveClass(),
          id: getNextAnnotationId(),
        };
        addAnnotation(ann);
      }
      pushHistory();
      render();
      showToast(`人脸 68 点: ${faces.length} 张 (${elapsed.toFixed(2)}s)`, 'success');
    } catch (e: any) {
      showToast(`人脸检测失败: ${e.message || e}`, 'error');
    } finally {
      faceRunning = false;
    }
  }


  // ====== 批量预标注 ======
  let batchRunning = $state(false);
  let batchProgress = $state(0);
  let batchTotal = $state(0);
  let batchModel = $state<'pose' | 'face' | 'pcs'>('pose');
  let batchScope = $state<'empty' | 'all'>('empty');
  let batchText = $state('');

  async function handleBatch() {
    if (batchRunning) return;
    const targets = images.filter(ii => {
      if (batchScope === 'all') return true;
      return !(annotations[ii.name] && annotations[ii.name].length > 0);
    });
    if (targets.length === 0) { showToast('没有需要处理的图片', 'error'); return; }
    if (batchModel === 'pcs' && !batchText.trim()) { showToast('请输入文本词', 'error'); return; }
    if (!confirm('将对 ' + targets.length + ' 张图片执行批量，开始？')) return;

    try {
      batchRunning = true;
      batchTotal = targets.length;
      batchProgress = 0;
      const dataUrls = targets.map(ii => ii.dataUrl);

      if (batchModel === 'pcs') {
        const results = await batchPcs(dataUrls, batchText, 0.5);
        for (let i = 0; i < results.length; i++) {
          const name = targets[i].name;
          const insts = results[i].instances;
          const newAnns = [];
          for (const inst of insts) {
            if (inst.polygon.length < 3) continue;
            newAnns.push({ type: 'polygon', points: inst.polygon, className: getActiveClass(), id: Date.now() + i * 10000 + newAnns.length });
          }
          annotations[name] = [...(annotations[name] || []), ...newAnns];
          batchProgress = i + 1;
        }
      } else {
        const results = await batchKp(dataUrls, batchModel, 0.25);
        for (let i = 0; i < results.length; i++) {
          const name = targets[i].name;
          const objs = results[i].objects;
          const newAnns = [];
          for (const o of objs) {
            newAnns.push({ type: 'keypoint', points: o.keypoints.map(k => ({ x: k.x, y: k.y })), className: getActiveClass(), id: Date.now() + i * 10000 + newAnns.length });
          }
          annotations[name] = [...(annotations[name] || []), ...newAnns];
          batchProgress = i + 1;
        }
      }
      pushHistory();
      saveAnnotations();
      render();
      showToast('批量完成: ' + batchProgress + '/' + batchTotal, 'success');
    } catch (e: any) {
      showToast('批量失败: ' + (e.message || e), 'error');
    } finally {
      batchRunning = false;
    }
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
    <!-- 智能分割 SAM（仅选 SAM 工具时显示）-->
    {#if ui.currentTool === 'sam'}
      <div class="section sam-section">
        <h4>智能分割 SAM</h4>
        <p class="muted">点击=正点 · Shift+点击=负点 · 拖拽=框选</p>

        <div class="sub-section">
          <div class="sub-title">文本提示（PCS）</div>
          <input type="text" class="pcs-input" placeholder="输入类别，如 cat/狗"
            bind:value={pcsText}
            onkeydown={(e) => { if (e.key === 'Enter' && !pcsRunning) handlePcsDetect(); }} />
          <div class="pcs-threshold-row">
            <label>阈值</label>
            <input type="number" step="0.05" min="0.05" max="0.95" bind:value={pcsThreshold} />
          </div>
          <button class="btn-sm btn-primary pcs-detect-btn" onclick={handlePcsDetect}
            disabled={pcsRunning || !pcsText.trim()}>
            {pcsRunning ? '检测中...' : '检测全部实例'}
          </button>

          {#if pcsResults.length > 0}
            <div class="pcs-result-bar">
              <span class="pcs-count">检测到 {pcsResults.length} 个实例 · {(pcsElapsed/1000).toFixed(2)}s</span>
              <button class="btn-accept-all" onclick={pcsAcceptAll}>全部接受</button>
            </div>
            <div class="pcs-list">
              {#each pcsResults as inst, idx (idx)}
                <div class="pcs-item"
                  onmouseenter={() => pcsHover(idx)}
                  onmouseleave={() => pcsHover(null)}>
                  <div class="pcs-item-info">
                    <span class="pcs-score">#{idx + 1}</span>
                    <span class="pcs-score">{inst.score.toFixed(3)}</span>
                    <span class="pcs-verts">{inst.polygon.length}pts</span>
                  </div>
                  <div class="pcs-item-actions">
                    <button class="pcs-accept-btn" onclick={() => pcsAccept(idx)} title="接受为标注">✓</button>
                    <button class="pcs-discard-btn" onclick={() => pcsDiscard(idx)} title="丢弃">✕</button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- 姿态预标注（仅 keypoint 工具时显示）-->
    {#if ui.currentTool === 'keypoint'}
      <div class="section sam-section">
        <h4>姿态预标注</h4>
        <p class="muted">自动检测并生成关键点标注</p>
        <button class="btn-sm btn-primary pcs-detect-btn" onclick={handlePoseDetect} disabled={poseRunning}>
          {poseRunning ? '检测中...' : '一键检测人体 (17点)'}
        </button>
        <button class="btn-sm btn-primary pcs-detect-btn" onclick={handleFaceDetect} disabled={faceRunning}>
          {faceRunning ? '检测中...' : '一键检测人脸 (68点)'}
        </button>
      </div>
    {/if}

    <!-- 批量预标注 -->
    <div class="section sam-section">
      <h4>批量预标注</h4>
      <p class="muted">先单图试跑满意后再批量</p>
      <div class="batch-row">
        <label>模型</label>
        <select bind:value={batchModel}>
          <option value="pose">人体 (17点)</option>
          <option value="face">人脸 (68点)</option>
          <option value="pcs">文本分割 (PCS)</option>
        </select>
      </div>
      {#if batchModel === 'pcs'}
        <input type="text" class="pcs-input" placeholder="输入类别，如 cat/狗" bind:value={batchText}>
      {/if}
      <div class="batch-row">
        <label>范围</label>
        <select bind:value={batchScope}>
          <option value="empty">未标注图片</option>
          <option value="all">全部图片</option>
        </select>
      </div>
      <button class="btn-sm btn-primary pcs-detect-btn" onclick={handleBatch} disabled={batchRunning}>
        {batchRunning ? '处理中 ' + batchProgress + '/' + batchTotal + '...' : '开始批量'}
      </button>
      {#if batchRunning}
        <div class="batch-progress">{batchProgress} / {batchTotal}</div>
      {/if}
    </div>

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
          {#each getCurrentAnnotations() as ann, i (ann.id + '__' + i)}
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

  /* ===== SAM PCS 智能分割区块 ===== */
  .sam-section {
    padding: 10px;
    background: linear-gradient(180deg, rgba(88,166,255,0.08), transparent);
    border: 1px solid rgba(88,166,255,0.25);
    border-radius: var(--radius-md);
  }
  .sam-section h4 {
    font-size: 11px; margin: 0 0 4px;
    text-transform: uppercase; letter-spacing: 0.8px;
    color: #58a6ff; font-weight: var(--weight-semibold);
  }
  .sam-section .muted { font-size: 10px; margin-bottom: 10px; }
  .sub-section { margin-top: 8px; }
  .sub-title {
    font-size: 10px; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.5px;
    margin-bottom: 6px; font-weight: var(--weight-medium);
  }
  .pcs-input {
    width: 100%; padding: 6px 8px;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-xs);
    box-sizing: border-box;
  }
  .pcs-input:focus { outline: none; border-color: #58a6ff; }
  .pcs-threshold-row {
    display: flex; align-items: center; gap: 8px;
    margin-top: 8px; font-size: 11px; color: var(--text-secondary);
  }
  .pcs-threshold-row input {
    width: 60px; padding: 3px 6px;
    background: var(--bg-primary); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text-primary);
    font-size: 11px;
  }
  .pcs-detect-btn { margin-top: 8px; width: 100%; }
  .pcs-result-bar {
    display: flex; align-items: center; justify-content: space-between;
    margin-top: 10px; padding-top: 8px;
    border-top: 1px solid var(--border);
  }
  .pcs-count { font-size: 10px; color: var(--text-secondary); }
  .btn-accept-all {
    padding: 3px 10px; font-size: 11px;
    background: #238636; color: #fff;
    border: 1px solid #2ea043; border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .btn-accept-all:hover { background: #2ea043; }
  .pcs-list { margin-top: 6px; max-height: 180px; overflow-y: auto; }
  .pcs-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 4px 8px; margin-bottom: 2px;
    border-radius: var(--radius-sm);
    cursor: pointer; font-size: 11px;
    transition: background 100ms;
  }
  .pcs-item:hover { background: rgba(88,166,255,0.12); }
  .pcs-item-info { display: flex; gap: 8px; align-items: center; }
  .pcs-score { color: #3fb950; font-family: var(--font-mono); }
  .pcs-verts { color: var(--text-muted); font-size: 10px; }
  .pcs-item-actions { display: flex; gap: 4px; }
  .pcs-accept-btn, .pcs-discard-btn {
    width: 22px; height: 22px;
    border: none; border-radius: var(--radius-sm);
    cursor: pointer; font-size: 12px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
  }
  .pcs-accept-btn { background: rgba(46,160,67,0.2); color: #3fb950; }
  .pcs-accept-btn:hover { background: #2ea043; color: #fff; }
  .pcs-discard-btn { background: rgba(248,81,73,0.15); color: #f85149; }
  .pcs-discard-btn:hover { background: #f85149; color: #fff; }

  .batch-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 11px; color: var(--text-secondary); }
  .batch-row select { flex: 1; padding: 4px 6px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 11px; }
  .batch-progress { margin-top: 6px; font-size: 11px; color: var(--accent-blue); font-family: var(--font-mono); }
</style>

















