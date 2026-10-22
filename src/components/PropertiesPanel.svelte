<script lang="ts">
  import { t } from '$lib/i18n.svelte';
  import {
    ui, images, classes, classColors, getClassCounts,
    COLORS, getClassColor, getCurrentAnnotations, selectAnnotation, deleteAnnotation,
    pushHistory, showToast, batchDeleteAll, getActiveClass, setActiveClass, annotations, saveAnnotations,
    getNextAnnotationId, addAnnotation, markModified, getKeypointCount, captureUndoBaseline,
  } from '$lib/state.svelte';
  import { keypointDisplayName } from '$lib/skeletons';
  import { render } from '$lib/canvas/engine.svelte';
  import type { ExportFormat, Annotation } from '$lib/types';
  import Icon from './Icon.svelte';
  import { segmentByText, isModelLoaded, clearCache as clearSamCache, poseDetect, faceDetect, batchPcs, batchKp, normalizePrompt, promptNeedsTranslation } from '$lib/sam';
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
    // 分类模式的「脏标记」必须走 markModified()，否则状态栏永远是「已保存」、
    // 工具栏的保存按钮也永远不亮 —— 之前这里只 pushHistory + saveAnnotations，
    // 没有任何东西会让 imageModified 变 true。
    markModified();
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
    // 必须补一次历史快照：batchDeleteAll() 自己不会 pushHistory，
    // 而这里（以及下面那句 toast）都明确承诺了「可撤销」。
    // 少了这一句，「7 个标注 → 清除 → Ctrl+Z」会退回 6 个：因为清除没进历史，
    // Ctrl+Z 撤掉的是上一次「添加第 7 个」的操作。
    pushHistory();
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
      // 首次调用时后端才懒加载 YOLOv8n-pose；提前说明，避免用户以为卡住
      if (!ui.samPoseLoaded) showToast('首次使用：正在加载人体姿态模型，约需 10~20 秒…', 'info');
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
          skeletonId: 'coco_body',
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
      // 人脸模型（2DFAN4）首次调用才加载，比姿态更慢一点
      if (!ui.samFaceLoaded) showToast('首次使用：正在加载人脸模型，约需 10~20 秒…', 'info');
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
          skeletonId: 'face_68',
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
  // 取消标志用普通变量：批量循环每张读一次即可，不需要驱动渲染
  let batchCancelFlag = false;
  let batchCancelling = $state(false);

  function cancelBatch() {
    batchCancelFlag = true;
    batchCancelling = true;
    showToast('正在取消，正在中断当前请求...', 'info');
  }

  /** 该图片下一个可用标注 id。不能用 getNextAnnotationId()——它只读当前图片，
   *  批量写的是别的图，会导致所有图共用同一批 id。 */
  function nextIdFor(imgName: string): number {
    const anns = annotations[imgName];
    return anns && anns.length > 0 ? Math.max(...anns.map(a => a.id)) + 1 : 0;
  }

  async function handleBatch() {
    if (batchRunning) return;
    const targets = images.filter(ii => {
      if (batchScope === 'all') return true;
      return !(annotations[ii.name] && annotations[ii.name].length > 0);
    });
    if (targets.length === 0) { showToast('没有需要处理的图片', 'error'); return; }
    if (batchModel === 'pcs' && !batchText.trim()) { showToast('请输入文本词', 'error'); return; }
    if (!confirm('将对 ' + targets.length + ' 张图片执行批量，开始？')) return;

    // 关键点模型是懒加载的：第一次批量会顺带加载，先说明一下
    if (batchModel !== 'pcs' && !(batchModel === 'pose' ? ui.samPoseLoaded : ui.samFaceLoaded)) {
      showToast(`首次使用：正在加载${batchModel === 'pose' ? '人体' : '人脸'}模型，约需 10~20 秒…`, 'info');
    }

    batchRunning = true;
    batchCancelFlag = false;
    batchCancelling = false;
    batchTotal = targets.length;
    batchProgress = 0;
    const failed: { name: string; error: string }[] = [];
    let added = 0;
    // 批量会一次改多张图：处理前先补齐每张图的撤销基线，并记录实际被改到的图。
    for (const t of targets) captureUndoBaseline(t.name);
    const changed: string[] = [];

    // 每处理完一张让出一帧，否则进度条在整批期间都停在 0，看起来就像卡死
    const onProgress = async (p: { done: number }) => {
      batchProgress = p.done;
      await new Promise(r => setTimeout(r, 0));
    };
    const opts = { onProgress, shouldCancel: () => batchCancelFlag };

    try {
      const dataUrls = targets.map(ii => ii.dataUrl);

      if (batchModel === 'pcs') {
        const results = await batchPcs(dataUrls, batchText, pcsThreshold, opts);
        for (let i = 0; i < results.length; i++) {
          const name = targets[i].name;
          const r = results[i];
          if (r.error) { failed.push({ name, error: r.error }); continue; }
          // scope=all 时该图可能已有标注，id 要接着它自己的最大值往后排
          let id = nextIdFor(name);
          const newAnns: Annotation[] = [];
          for (const inst of r.instances) {
            if (inst.polygon.length < 3) continue;
            newAnns.push({ type: 'polygon', points: inst.polygon, className: getActiveClass(), id: id++ });
          }
          if (newAnns.length > 0) {
            annotations[name] = [...(annotations[name] || []), ...newAnns];
            added += newAnns.length;
            changed.push(name);
          }
        }
      } else {
        const results = await batchKp(dataUrls, batchModel, 0.25, opts);
        for (let i = 0; i < results.length; i++) {
          const name = targets[i].name;
          const r = results[i];
          if (r.error) { failed.push({ name, error: r.error }); continue; }
          let id = nextIdFor(name);
          const skelId = batchModel === 'face' ? 'face_68' : 'coco_body';
          const newAnns: Annotation[] = [];
          for (const o of r.objects) {
            newAnns.push({
              type: 'keypoint',
              points: o.keypoints.map(k => ({ x: k.x, y: k.y })),
              className: getActiveClass(),
              id: id++,
              skeletonId: skelId,
            });
          }
          if (newAnns.length > 0) {
            annotations[name] = [...(annotations[name] || []), ...newAnns];
            added += newAnns.length;
            changed.push(name);
          }
        }
      }

      // 一次批量涉及的图整体进一条历史，Ctrl+Z 才能整体还原
      pushHistory(changed);
      saveAnnotations();
      render();

      const doneText = `${batchProgress}/${batchTotal}`;
      if (batchCancelFlag) {
        showToast(`已取消：处理 ${doneText}，新增 ${added} 个标注`, 'info');
      } else if (failed.length > 0) {
        showToast(`批量完成 ${doneText}，新增 ${added} 个；失败 ${failed.length} 张（${failed[0].name}: ${failed[0].error}）`, 'error');
      } else {
        showToast(`批量完成 ${doneText}，新增 ${added} 个标注`, 'success');
      }
    } catch (e: any) {
      showToast('批量失败: ' + (e?.message || e), 'error');
    } finally {
      batchRunning = false;
      batchCancelling = false;
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
            <div class="class-item" class:selected={isSelected} role="button" tabindex="0"
              onclick={() => toggleImageLabel(c)}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleImageLabel(c); } }}>
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
        {#if !ui.samModelReady}
          <div class="sam-state-line">
            <span class="sam-dot"
              class:ok={ui.samBackendState === 'ready'}
              class:busy={ui.samBackendState === 'starting' || ui.samBackendState === 'loading'}
              class:err={ui.samBackendState === 'error'}></span>
            <span class="pcs-hint" style="margin-top:0">
              {#if ui.samBackendState === 'ready'}
                模型已就绪：打开工具栏「SAM智能分割」→ 点「连接后端服务」
              {:else if ui.samBackendState === 'starting' || ui.samBackendState === 'loading'}
                模型正在加载中…（首次约 10~30 秒），就绪后即可连接
              {:else}
                后端未连接：点工具栏的 SAM 图标 → 「连接后端服务」，连上后这里会自动可用
              {/if}
            </span>
          </div>
        {/if}
        <p class="muted">点击=正点 · Shift+点击=负点 · 拖拽=框选</p>

        <div class="sub-section">
          <div class="sub-title">文本提示（PCS）</div>
          <input type="text" class="pcs-input" placeholder="英文最准，如 cat / flower（也可直接输中文）"
            bind:value={pcsText}
            onkeydown={(e) => { if (e.key === 'Enter' && !pcsRunning) handlePcsDetect(); }} />
          {#if pcsText.trim()}
            <div class="pcs-hint">
              {#if promptNeedsTranslation(pcsText)}
                将按英文「{normalizePrompt(pcsText)}」送给模型（SAM3 文本编码器只支持英文）
              {:else}
                提示词：{pcsText.trim()}
              {/if}
            </div>
          {:else}
            <div class="pcs-hint">模型只认英文提示词，中文会自动转成英文（如「花朵」→ flower）</div>
          {/if}
          <div class="pcs-threshold-row">
            <label for="pp-pcs-th">阈值</label>
            <input id="pp-pcs-th" type="number" step="0.05" min="0.05" max="0.95" bind:value={pcsThreshold} />
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
                <div class="pcs-item" role="listitem"
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

    <!-- 魔术棒参数（仅魔术棒工具时显示）-->
    {#if ui.currentTool === 'magicwand'}
      <div class="section sam-section wand-section">
        <h4>魔术棒</h4>
        <p class="muted">在画布上点击要选取的颜色区域，自动生成多边形</p>
        <div class="wand-row">
          <label for="pp-wand-tol">颜色容差</label>
          <input id="pp-wand-tol" type="range" min="1" max="255" step="1" bind:value={ui.magicWandTolerance} />
          <span class="wand-value">{ui.magicWandTolerance}</span>
        </div>
        <div class="wand-row">
          <label for="pp-wand-simp">轮廓简化</label>
          <input id="pp-wand-simp" type="range" min="0" max="20" step="0.5" bind:value={ui.magicWandSimplify} />
          <span class="wand-value">{ui.magicWandSimplify}</span>
        </div>
        <div class="wand-row wand-check">
          <label for="wand-contiguous">只取连通区域</label>
          <input id="wand-contiguous" type="checkbox" bind:checked={ui.magicWandContiguous} />
        </div>
        <p class="muted">
          容差越大选中的颜色范围越广（全图同色区域较大时容易把背景一起选上）；
          关掉「只取连通区域」＝按颜色全局匹配。简化越大顶点越少。
        </p>
      </div>
    {/if}

    <!-- 姿态预标注（仅 keypoint 工具时显示）-->
    {#if ui.currentTool === 'keypoint'}
      <div class="section sam-section">
        <h4>姿态预标注</h4>
        <p class="muted">自动检测并生成关键点标注</p>
        <button class="btn-sm btn-primary pcs-detect-btn" onclick={handlePoseDetect} disabled={poseRunning}>
          {poseRunning ? (ui.samPoseLoaded ? '检测中...' : '首次加载中...') : '一键检测人体 (17点)'}
        </button>
        <button class="btn-sm btn-primary pcs-detect-btn" onclick={handleFaceDetect} disabled={faceRunning}>
          {faceRunning ? (ui.samFaceLoaded ? '检测中...' : '首次加载中...') : '一键检测人脸 (68点)'}
        </button>
        <p class="muted model-hint">
          首次使用需加载对应模型（约 10~20 秒），按钮会显示「首次加载中...」，不是卡住。
        </p>
      </div>
    {/if}

    <!-- 批量预标注 -->
    <div class="section sam-section">
      <h4>批量预标注</h4>
      <p class="muted">先单图试跑满意后再批量</p>
      <div class="batch-row">
        <label for="pp-batch-model">模型</label>
        <select id="pp-batch-model" bind:value={batchModel}>
          <option value="pose">人体 (17点)</option>
          <option value="face">人脸 (68点)</option>
          <option value="pcs">文本分割 (PCS)</option>
        </select>
      </div>
      {#if batchModel === 'pcs'}
        <input type="text" class="pcs-input" placeholder="英文最准，如 flower（也可输中文）" bind:value={batchText}>
      {:else if !(batchModel === 'pose' ? ui.samPoseLoaded : ui.samFaceLoaded)}
        <p class="muted model-hint">首次使用该模型需加载（约 10~20 秒），请稍候。</p>
      {/if}
      <div class="batch-row">
        <label for="pp-batch-scope">范围</label>
        <select id="pp-batch-scope" bind:value={batchScope}>
          <option value="empty">未标注图片</option>
          <option value="all">全部图片</option>
        </select>
      </div>
      <button class="btn-sm btn-primary pcs-detect-btn" onclick={handleBatch} disabled={batchRunning}>
        {batchRunning ? '处理中 ' + batchProgress + '/' + batchTotal + '...' : '开始批量'}
      </button>
      {#if batchRunning}
        <div class="batch-progress">{batchProgress} / {batchTotal}</div>
        <div class="batch-bar"><div class="batch-bar-fill" style="width:{batchTotal ? Math.round(batchProgress / batchTotal * 100) : 0}%"></div></div>
        <button class="btn-sm batch-cancel" onclick={cancelBatch} disabled={batchCancelling}>
          {batchCancelling ? '取消中...' : '取消'}
        </button>
      {/if}
    </div>

    <!-- Annotation Info -->
    <div class="section">
      <h4>{t('annotationInfo')}</h4>
      {#if ui.selectedAnnotation}
        {@const ann = ui.selectedAnnotation}
        <div class="row"><span class="lbl">{t('id')}</span><span>{ann.id}</span></div>
        <div class="row"><span class="lbl">{t('type')}</span><span>{ann.type}</span></div>
        {#if ann.type === 'keypoint'}
          <!-- 关键点没有「目标类别」，只有「骨架类型」 -->
          <div class="row"><span class="lbl">骨架</span><span>{keypointDisplayName(ann.points.length, ann.skeletonId)}</span></div>
        {:else}
          <div class="row"><span class="lbl">{t('label')}</span>
            <select value={ann.className} onchange={(e) => props.onChangeClass(ann.id, (e.target as HTMLSelectElement).value)}>
              {#each classes as c}
                <option value={c} selected={ann.className === c}>{c}</option>
              {/each}
            </select>
          </div>
        {/if}
        {#if ann.type === 'rect'}
          <div class="row"><span class="lbl">X</span><span>{ann.x.toFixed(1)}</span></div>
          <div class="row"><span class="lbl">Y</span><span>{ann.y.toFixed(1)}</span></div>
          <div class="row"><span class="lbl">W</span><span>{ann.w.toFixed(1)}</span></div>
          <div class="row"><span class="lbl">H</span><span>{ann.h.toFixed(1)}</span></div>
        {:else if ann.type === 'rotated'}
          <div class="row"><span class="lbl">CX</span><span>{ann.cx.toFixed(1)}</span></div>
          <div class="row"><span class="lbl">CY</span><span>{ann.cy.toFixed(1)}</span></div>
          <div class="row"><span class="lbl">W</span><span>{ann.w.toFixed(1)}</span></div>
          <div class="row"><span class="lbl">H</span><span>{ann.h.toFixed(1)}</span></div>
          <div class="row"><span class="lbl">Angle</span><span>{ann.angle.toFixed(1)}°</span></div>
        {:else if ann.type === 'polygon' || ann.type === 'keypoint'}
          <div class="row"><span class="lbl">{t('coordinates')}</span><span>{ann.points.length} pts</span></div>
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
            <div class="ann-item" class:active={ui.selectedAnnotation?.id === ann.id} role="button" tabindex="0"
              onclick={() => selectAnnotation(ann)}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAnnotation(ann); } }}>
              <span class="ann-type" style="color:{getClassColor(ann.className)}">{getTypeIcon(ann)}</span>
              <span class="ann-class">{ann.type === 'keypoint' ? keypointDisplayName(ann.points.length, ann.skeletonId) : ann.className}</span>
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
      {#if getKeypointCount() > 0}
        <p class="muted">另有 {getKeypointCount()} 个关键点骨架，不计入下面的类别统计</p>
      {/if}
      {#each classes as c, i}
        <div class="class-item" class:active={getActiveClass() === c} role="button" tabindex="0"
          onclick={() => setActiveClass(c)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveClass(c); } }}>
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
    {/if}

    <!-- Export — 两种模式都必须有。
         以前整个 Export 区块都写在检测模式的 {:else} 分支里，
         分类模式下连导出按钮都不存在，用户只能去点工具栏那个 ↓，
         而那个入口写盘失败也会报「导出成功」。 -->
    <div class="section">
      <h4>{t('export')}</h4>
      {#if ui.workMode === 'classification'}
        <p class="muted">导出「文件名, 标签」两列的 CSV，一张图多个标签就多行</p>
        <div class="export-buttons">
          <button class="btn-sm btn-primary" onclick={props.onBatchExport}>导出分类标签 CSV</button>
        </div>
      {:else}
        <div class="export-format">
          <label for="pp-export-format">{t('chooseFormat')}</label>
          <select id="pp-export-format" value={ui.exportFormat} onchange={(e) => ui.exportFormat = (e.target as HTMLSelectElement).value as ExportFormat}>
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
      {/if}
    </div>
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
  .row .lbl { color: var(--text-secondary); font-size: var(--text-xs); }
  .row select {
    width: 100px; padding: 5px 8px;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    transition: all var(--transition-fast);
  }
  .row select:focus {
    border-color: var(--accent-blue);
    box-shadow: 0 0 0 2px rgba(77,163,255,0.15);
  }
  .muted { color: var(--text-muted); font-size: var(--text-sm); }
  /* 首次加载提示：比普通说明再小一档，不抢按钮的注意力 */
  .model-hint { font-size: 11px; line-height: 1.5; }

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
  .pcs-hint {
    margin-top: 4px;
    font-size: 10.5px;
    line-height: 1.4;
    color: var(--text-muted, #8b949e);
    word-break: break-all;
  }
  /* SAM 工具里的后端状态行：与弹窗/分割面板同一套颜色语义 */
  .sam-state-line { display: flex; align-items: flex-start; gap: 6px; margin-top: 6px; }
  .sam-dot {
    width: 7px; height: 7px; border-radius: 50%; flex: none;
    background: var(--text-muted, #8b949e); margin-top: 3px;
  }
  .sam-dot.ok { background: #3fb950; }
  .sam-dot.busy { background: #d2991d; animation: sam-hint-pulse 1.1s ease-in-out infinite; }
  .sam-dot.err { background: #f85149; }
  @keyframes sam-hint-pulse { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }
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
  .batch-bar { margin-top: 6px; height: 4px; background: var(--bg-tertiary); border-radius: 2px; overflow: hidden; }
  .batch-bar-fill { height: 100%; background: var(--accent-blue); border-radius: 2px; transition: width 0.2s ease; }
  .batch-cancel { margin-top: 6px; }

  /* ===== 魔术棒参数区块 ===== */
  .wand-section { background: linear-gradient(180deg, rgba(163,113,247,0.10), transparent); border-color: rgba(163,113,247,0.28); }
  .wand-section h4 { color: #a371f7; }
  .wand-row {
    display: flex; align-items: center; gap: 8px;
    margin: 6px 0; font-size: 11px; color: var(--text-secondary);
  }
  .wand-row label { flex: 0 0 auto; }
  .wand-row input[type="range"] { flex: 1; min-width: 0; accent-color: #a371f7; height: 16px; }
  .wand-value {
    flex: 0 0 32px; text-align: right;
    font-family: var(--font-mono); font-size: 11px; color: var(--text-primary);
  }
  .wand-check { justify-content: space-between; }
  .wand-check input[type="checkbox"] { accent-color: #a371f7; }
</style>

















