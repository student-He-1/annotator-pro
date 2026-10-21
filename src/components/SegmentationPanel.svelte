<script lang="ts">
  /** 图像分割模式的属性面板（第三个模式）。
   *  刻意做成**独立组件**而不是往 PropertiesPanel 里塞 if 分支：
   *  那个文件是检测/分类两种模式的共用面板，往里加分割区块必然要碰它们的渲染条件
   *  （铁律 A 只允许「加可选字段 / 加 early-return / 等价收紧」，改它的模板结构不在此列）。
   *  这里只读 state 的 `ui.seg*` 和 segmentation/store 的接口，对其它两个模式零影响。 */
  import { ui, images, showToast } from '$lib/state.svelte';
  import { render } from '$lib/canvas/engine.svelte';
  import {
    getCandidates, acceptCandidate, discardCandidate, acceptAllCandidates, discardAllCandidates,
    getRegions, selectRegion, deleteRegion, setRegionClass, toggleRegionHidden,
    clearImageMask, colorOfSegClass, ensureSegClass, checkSegBackend, runTextPrompt,
    canUndoMask, canRedoMask, undoMask, redoMask, getMaskDirty, getImageMask,
    runClassSweep, cancelClassSweep, toggleSweepClass, selectAllSweepClasses, clearSweepClasses,
    reviewSweepClass, cleanupSmallIslands, getRefinePoints, clearRefinePoints,
    runBatchSweep, setHoverCandidate, measureCandidateOverlap,
    filterSmallCandidates, deleteSmallRegions, getImagesWithMasks,
    getReviewQueue, previewReviewItem, discardReviewItem, clearReviewQueue, nextReviewItem,
    runYoloToMasks,
  } from '$lib/segmentation/store.svelte';
  import { loadModel } from '$lib/yolo';
  import { SEG_PRESETS } from '$lib/segmentation/presets';
  import { describeMasks, getUnmappedCityscapesClasses, SEG_EXPORT_FORMATS } from '$lib/export/segmentation-export';
  import { getSegEmbedRequestCount, getSegEmbedCacheSize } from '$lib/segmentation/samMask';

  const colorOf = colorOfSegClass;

  interface Props {
    onExportCurrent: () => void;
    onBatchExport: () => void;
    onClose: () => void;
  }
  let props: Props = $props();

  let newClass = $state('');
  let busy = $state(false);
  let yoloConf = $state(0.25);
  let yoloLoading = $state(false);
  let yoloFileInput: HTMLInputElement;

  const curName = $derived(images[ui.currentImageIndex]?.name || '');
  // $derived 里读 ui.maskRev 才会在掩膜变化时重算（掩膜本体不在 $state 里）
  const regions = $derived((ui.maskRev, curName ? getRegions(curName) : []));
  const cands = $derived((ui.maskRev, getCandidates()));
  const reviewQueue = $derived((ui.maskRev, getReviewQueue()));
  const selected = $derived(ui.segSelectedRegion);
  /** Cityscapes 语义图导出前要提醒的「映射不到」类别（它们会被写成 void=255） */
  const unmapped = $derived((ui.maskRev, curName ? getUnmappedCityscapesClasses(getImageMask(curName)) : []));
  const refineCount = $derived((ui.maskRev, getRefinePoints().length));
  /** 编码次数/缓存张数：纯函数读不出响应式，必须挂在 ui.maskRev 上（每次候选/掩膜变化都会 bump） */
  const embedInfo = $derived((ui.maskRev, {
    requests: getSegEmbedRequestCount(),
    cache: getSegEmbedCacheSize(),
  }));

  async function startSweep() {    if (busy) return;
    busy = true;
    try {
      // 传 render 进去：扫描是逐词合并的，每合并完一个词就重画一次，边扫边能看到掩膜
      await runClassSweep(() => render());
      render();
    } finally {
      busy = false;
    }
  }

  async function startBatchSweep() {
    if (busy) return;
    busy = true;
    try {
      await runBatchSweep(() => render());
      render();
    } finally {
      busy = false;
    }
  }

  async function reviewClass(className: string) {
    busy = true;
    try {
      await reviewSweepClass(className);
      render();
    } finally {
      busy = false;
    }
  }

  async function prompt(text: string) {
    if (busy) return;
    busy = true;
    try {
      await runTextPrompt(text);
      render();
    } finally {
      busy = false;
    }
  }

  function onPromptKey(e: KeyboardEvent) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = (ui.segText || '').trim();
    if (text) void prompt(text);
  }

  async function connectBackend() {
    busy = true;
    try {
      await checkSegBackend();
      render();
    } finally {
      busy = false;
    }
  }

  /** 重叠检测：接受前先算会盖掉多少已有区域，确认后再写（单索引图的覆盖语义）。
   *  ks 不传 = 全部候选。 */
  function confirmOverlap(ks?: number[]): boolean {
    const ov = measureCandidateOverlap(curName, ks);
    if (ov.px === 0) return true;
    return confirm(
      `本次接受会覆盖已有区域的 ${ov.px.toLocaleString()} 个像素（涉及 ${ov.regions} 个区域）。\n\n` +
      `单索引图里后接受的区域会盖住前面的；继续吗？`
    );
  }

  function doAccept(k: number, className: string, kind: 'instance' | 'stuff') {
    if (!confirmOverlap([k])) return;
    acceptCandidate(k, className, kind);
    render();
  }

  function doAcceptAll() {
    if (!confirmOverlap()) return;
    acceptAllCandidates();
    render();
  }

  function doFilterCandidates() {
    const n = filterSmallCandidates(Number(ui.segMinAreaPx) || 0);
    if (n > 0) render();
  }

  function doDeleteSmallRegions() {
    if (regions.length === 0) return;
    const min = Number(ui.segMinAreaPx) || 0;
    if (min <= 0) { showToast('请先填写面积阈值（px）', 'info'); return; }
    if (!confirm(`确定删除当前图中面积小于 ${min} px 的区域吗？可用撤销恢复。`)) return;
    if (deleteSmallRegions(min) > 0) render();
  }

  function doDiscard(k: number) {
    discardCandidate(k);
    render();
  }

  function doPreviewReview(id: string) {
    if (previewReviewItem(id)) render();
  }

  function doDiscardReview(id: string) {
    discardReviewItem(id);
    render();
  }

  function doNextReview() {
    if (!nextReviewItem()) showToast('复核队列已空', 'info');
    else render();
  }

  function doClearReview() {
    if (reviewQueue.length === 0) return;
    if (!confirm(`确定清空 ${reviewQueue.length} 个复核候选吗？`)) return;
    clearReviewQueue();
    render();
  }

  async function pickYoloModel(e: Event) {
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

  async function runYolo(scope: 'current' | 'all') {
    if (busy || ui.segSweepRunning) return;
    busy = true;
    try {
      await runYoloToMasks({ scope, yoloConf, onProgress: () => render() });
      render();
    } finally {
      busy = false;
    }
  }

  function doRegionClick(ordinal: number) {
    // 点行永远是「选中」，不做 toggle：toggle 会让人「点一下取消选中」而不自知，
    // 之后画笔/负点修正就成了「没有目标区域」。取消选中请点画布空白。
    selectRegion(ordinal);
    render();
  }

  function doDelete(ordinal: number) {
    deleteRegion(ordinal);
    render();
  }

  function doChangeClass(ordinal: number, cls: string) {
    setRegionClass(ordinal, cls);
    render();
  }

  function doToggleHidden(ordinal: number) {
    toggleRegionHidden(ordinal);
    render();
  }

  function doUndo() { if (undoMask()) render(); }
  function doRedo() { if (redoMask()) render(); }

  function doClearCurrent() {
    if (regions.length === 0) return;
    if (!confirm(`确定清除当前图片的 ${regions.length} 个区域吗？可用撤销恢复。`)) return;
    clearImageMask();
    render();
  }

  function doCleanupIslands() {
    cleanupSmallIslands(Number(ui.segIslandMinPx) || 64);
    render();
  }

  function addClass() {
    const name = newClass.trim();
    if (!name) return;
    ensureSegClass(name);
    newClass = '';
  }

  function usePointClass(name: string) {
    ui.segActiveClass = name;
    if (ui.currentTool !== 'seg_point') ui.currentTool = 'seg_point';
  }
</script>

<div class="seg-panel">
  <div class="seg-header">
    <h3>图像分割</h3>
    <button class="close-btn" onclick={props.onClose} title="关闭面板">×</button>
  </div>

  <div class="seg-content">
    <!-- 后端状态 -->
    <div class="section">
      <div class="row-line">
        <span class="dot" class:ok={ui.segBackendReady && ui.segMaskSupported} class:warn={ui.segBackendReady && !ui.segMaskSupported}></span>
        <span class="tiny">
          {ui.segBackendReady
            ? (ui.segMaskSupported ? 'SAM3 后端已连接 · 支持像素级掩膜' : '后端在线，但版本太旧（无 mask 能力）')
            : 'SAM3 后端未连接'}
        </span>
        <button class="btn-mini" onclick={connectBackend} disabled={busy}>{busy ? '…' : '连接'}</button>
      </div>
      <p class="muted tiny">掩膜改动和标注一样自动保存（Ctrl+S 同款），工程文件用「保存工程」落盘。</p>
      <p class="muted tiny">编码 {embedInfo.requests} 次 · 缓存 {embedInfo.cache} 张（切回前几张图不会再重编码）</p>
    </div>

    <!-- 文本提示：主力工作流 -->
    <div class="section">
      <h4>文本提示（回车出候选）</h4>
      <input class="text-input" type="text" placeholder="任意英文词，如 car / road / sidewalk"
        bind:value={ui.segText} onkeydown={onPromptKey} />
      <div class="row-line">
        <label class="tiny" for="seg-conf">阈值</label>
        <input id="seg-conf" class="num-input" type="number" step="0.05" min="0.05" max="0.95" bind:value={ui.segConfThreshold} />
        <span class="muted tiny">一次编码可反复换词，每个词几十毫秒</span>
      </div>
      <div class="chips">
        {#each SEG_PRESETS as p}
          <button class="chip" style="border-color:{p.color}" title={`${p.kind === 'stuff' ? '整片' : '实例'} · 点击即出候选`}
            onclick={() => { ui.segText = p.name; void prompt(p.name); }} disabled={busy}>{p.name}</button>
        {/each}
      </div>
    </div>

    <!-- 一键全类扫描：SAM3 是 promptable 的，不给词不会自己分割，所以「一键识图」= 词表逐个跑 -->
    <div class="section">
      <div class="row-line">
        <h4 style="margin:0">一键扫描</h4>
        <button class="btn-mini" onclick={() => { selectAllSweepClasses(); }}>全选</button>
        <button class="btn-mini" onclick={() => { clearSweepClasses(); }}>全不选</button>
      </div>
      <p class="muted tiny">
        勾选类别后逐个跑 SAM3：分数 ≥ 自动接受阈值直接进掩膜，中间的留作复核。整轮只占**一个** Ctrl+Z。
      </p>
      <div class="chips">
        {#each ui.segClasses as c}
          <button class="chip small" class:active={ui.segSweepClasses.includes(c)}
            style="border-color:{colorOf(c)}" disabled={ui.segSweepRunning}
            onclick={() => toggleSweepClass(c)}>{c}</button>
        {/each}
      </div>
      <div class="row-line">
        <label class="tiny" for="seg-auto-accept">自动接受 ≥</label>
        <input id="seg-auto-accept" class="num-input" type="number" step="0.05" min="0.05" max="0.99" bind:value={ui.segSweepAutoAccept} />
        <span class="muted tiny">（低于它、且高于上面的请求阈值 → 待复核）</span>
      </div>
      {#if ui.segSweepRunning}
        <div class="row-line">
          {#if ui.segBatchRunning}
            <span class="tiny">批量 {ui.segBatchDone}/{ui.segBatchTotal} 张 · {ui.segBatchCurrent || '…'}</span>
          {:else}
            <span class="tiny">扫描中 {ui.segSweepDone}/{ui.segSweepTotal} · {ui.segSweepCurrent || '…'}</span>
          {/if}
          <button class="btn-mini danger" onclick={() => cancelClassSweep()}>取消</button>
        </div>
        <div class="bar">
          <div class="bar-fill" style="width:{ui.segBatchRunning
            ? (ui.segBatchTotal ? Math.round(ui.segBatchDone / ui.segBatchTotal * 100) : 0)
            : (ui.segSweepTotal ? Math.round(ui.segSweepDone / ui.segSweepTotal * 100) : 0)}%"></div>
        </div>
      {:else}
        <div class="row-line">
          <button class="btn-mini primary" onclick={startSweep}
            disabled={ui.segSweepClasses.length === 0 || busy}>开始扫描（{ui.segSweepClasses.length} 类）</button>
          <button class="btn-mini" onclick={startBatchSweep}
            disabled={ui.segSweepClasses.length === 0 || busy || !images.length}
            title="对每张已导入的图各跑一遍；每张图各自一个撤销点">批量扫描全部图片</button>
        </div>
      {/if}
      {#if ui.segSweepResults.length > 0}
        <div class="list" style="max-height:180px">
          {#each ui.segSweepResults as r (r.className)}
            <div class="item">
              <span class="swatch" style="background:{colorOf(r.className)}"></span>
              <span class="cls">{r.className}</span>
              <span class="tiny">接受 {r.accepted}</span>
              {#if r.review > 0}
                <span class="kind stuff">复核 {r.review}</span>
              {/if}
              <span class="muted tiny">{r.elapsedMs}ms</span>
              {#if r.error}
                <span class="muted tiny warn-text" title={r.error}>失败</span>
              {:else if r.review > 0}
                <button class="btn-mini" title="重新取回这个词的候选逐个确认"
                  onclick={() => reviewClass(r.className)}>复核</button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- YOLO 框 → 掩膜（A1） -->
    <div class="section">
      <h4>YOLO 框 → 掩膜</h4>
      <p class="muted tiny">
        本地 ONNX 检测框 → SAM3 按框抠掩膜；高分数自动接受，中间分进复核队列。需要 Python 后端支持 box。
      </p>
      <div class="row-line">
        <span class="muted tiny">
          模型：{ui.yoloModelName || '未加载'}{ui.yoloModelName ? `（${ui.yoloClassCount} 类）` : ''}
        </span>
        <button class="btn-mini" onclick={() => yoloFileInput.click()}
          disabled={busy || yoloLoading || ui.segSweepRunning}>
          {yoloLoading ? '加载中…' : '选择 .onnx'}
        </button>
        <input style="display:none" type="file" accept=".onnx" bind:this={yoloFileInput} onchange={pickYoloModel} />
      </div>
      <div class="row-line">
        <label class="muted tiny" for="yolo-conf">YOLO 置信度</label>
        <input id="yolo-conf" class="text-input" type="number" bind:value={yoloConf}
          min="0" max="1" step="0.05" style="width:70px" />
        <span class="muted tiny">SAM 分数阈值沿用上方「候选 / 自动接受」</span>
      </div>
      <div class="row-line">
        <button class="btn-mini primary" onclick={() => runYolo('current')}
          disabled={busy || !ui.yoloModelName || ui.segSweepRunning}>当前图</button>
        <button class="btn-mini" onclick={() => runYolo('all')}
          disabled={busy || !ui.yoloModelName || ui.segSweepRunning || !images.length}>全部图片</button>
      </div>
    </div>

    <!-- 跨图复核队列（A2） -->
    {#if reviewQueue.length > 0}
      <div class="section">
        <div class="row-line">
          <h4 style="margin:0">复核队列 {reviewQueue.length}</h4>
          <button class="btn-mini" onclick={doNextReview} title="按分数从低到高切到下一项">下一项</button>
          <button class="btn-mini" onclick={doClearReview}>清空</button>
        </div>
        <p class="muted tiny">按分数从低到高。点「◎」切到对应图片并把它挂成候选，再用 ✓ / Enter 接受。</p>
        <div class="list">
          {#each reviewQueue as q (q.id)}
            <div class="item cand" role="listitem" title={q.imageName}>
              <span class="idx">{q.score.toFixed(2)}</span>
              <span class="cls">{q.className}</span>
              <span class="kind" class:stuff={q.kind === 'stuff'}>{q.kind === 'stuff' ? '整片' : '实例'}</span>
              <span class="muted tiny" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                {q.imageName.split(/[\\/]/).pop() || q.imageName}
              </span>
              <span class="muted tiny">{q.area.toLocaleString()}px</span>
              <button class="btn-icon" title="复核这张图" onclick={() => doPreviewReview(q.id)}>◎</button>
              <button class="btn-icon no" title="丢弃" onclick={() => doDiscardReview(q.id)}>✕</button>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- 候选 -->
    {#if cands.length > 0}
      <div class="section">
        <div class="row-line">
          <h4 style="margin:0">候选 {cands.length}</h4>
          <button class="btn-mini primary" onclick={doAcceptAll}>全部接受</button>
          <button class="btn-mini" onclick={() => { discardAllCandidates(); render(); }}>全部丢弃</button>
        </div>
        <div class="list">
          {#each cands as c (c.k)}
            <div class="item cand" role="listitem" title="鼠标停在行上会在画布上提亮这个候选"
              onmouseenter={() => { setHoverCandidate(c.k); render(); }}
              onmouseleave={() => { setHoverCandidate(0); render(); }}>
              <span class="idx">#{c.k}</span>
              <span class="cls">{c.className}</span>
              <span class="kind" class:stuff={c.kind === 'stuff'}>{c.kind === 'stuff' ? '整片' : '实例'}</span>
              <span class="muted tiny">{c.area.toLocaleString()}px · {c.score.toFixed(2)}</span>
              <button class="btn-icon ok" title="接受" onclick={() => doAccept(c.k, c.className, c.kind)}>✓</button>
              <button class="btn-icon no" title="丢弃" onclick={() => doDiscard(c.k)}>✕</button>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- 区域列表 -->
    <div class="section">
      <div class="row-line">
        <h4 style="margin:0">区域 {regions.length}</h4>
        <button class="btn-mini" onclick={doUndo} disabled={!canUndoMask()} title="撤销（掩膜独立撤销栈）">撤销</button>
        <button class="btn-mini" onclick={doRedo} disabled={!canRedoMask()} title="重做">重做</button>
        <button class="btn-mini danger" onclick={doClearCurrent} disabled={regions.length === 0}>清空</button>
      </div>
      {#if regions.length === 0}
        <p class="muted tiny">
          {curName ? '这张图还没有区域：敲一个词，回车出候选。' : '先导入并选中一张图片。'}
        </p>
      {:else}
        <div class="list">
          {#each regions as r (r.ordinal)}
            <div class="item region" class:sel={selected === r.ordinal} role="button" tabindex="0"
              onclick={() => doRegionClick(r.ordinal)}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doRegionClick(r.ordinal); } }}>
              <span class="swatch" style="background:{colorOf(r.className)}"></span>
              <span class="idx">{r.ordinal}</span>
              <select class="cls-select" value={r.className}
                onclick={(e) => e.stopPropagation()}
                onchange={(e) => { e.stopPropagation(); doChangeClass(r.ordinal, (e.target as HTMLSelectElement).value); }}>
                {#each ui.segClasses as c}
                  <option value={c} selected={c === r.className}>{c}</option>
                {/each}
                {#if !ui.segClasses.includes(r.className)}
                  <option value={r.className} selected>{r.className}</option>
                {/if}
              </select>
              <span class="kind" class:stuff={r.kind === 'stuff'}>{r.kind === 'stuff' ? '整片' : '实例'}</span>
              <span class="muted tiny">{r.area ? r.area.toLocaleString() + 'px' : ''}</span>
              <button class="btn-icon" title={r.hidden ? '显示' : '隐藏'} onclick={(e) => { e.stopPropagation(); doToggleHidden(r.ordinal); }}>
                {r.hidden ? '🚫' : '👁'}
              </button>
              <button class="btn-icon no" title="删除区域" onclick={(e) => { e.stopPropagation(); doDelete(r.ordinal); }}>✕</button>
            </div>
          {/each}
        </div>
      {/if}
      {#if getMaskDirty(curName)}
        <p class="muted tiny warn-text">有未保存的掩膜改动（停手 0.5 秒会自动保存）</p>
      {/if}
    </div>

    <!-- 修正工具 -->
    <div class="section">
      <h4>修正</h4>
      <div class="row-line">
        <label class="tiny" for="seg-brush-size">笔刷</label>
        <input id="seg-brush-size" type="range" min="2" max="120" step="1" bind:value={ui.segBrushSize} />
        <span class="tiny">{ui.segBrushSize}px</span>
      </div>
      <p class="muted tiny">
        画笔(W) 补漏、橡皮(E) 削边。画笔默认画进「选中的区域」；没选中就用当前激活类别最近的那个区域，
        再没有就新建一个。一笔 = 一个 Ctrl+Z。
      </p>
      <div class="row-line">
        <label class="tiny" for="seg-island-min">清理孤岛 &lt;</label>
        <input id="seg-island-min" class="num-input" type="number" min="1" max="100000" bind:value={ui.segIslandMinPx} />
        <span class="tiny">px</span>
        <button class="btn-mini" onclick={doCleanupIslands} disabled={regions.length === 0}>清理</button>
      </div>
      <div class="row-line">
        <span class="tiny">小目标 &lt;</span>
        <input class="num-input" type="number" min="0" max="10000000" bind:value={ui.segMinAreaPx} />
        <span class="tiny">px</span>
        <button class="btn-mini" onclick={doFilterCandidates} disabled={cands.length === 0}
          title="丢弃面积小于阈值的候选（可重新出候选）">过滤候选</button>
        <button class="btn-mini" onclick={doDeleteSmallRegions} disabled={regions.length === 0}
          title="删除面积小于阈值的已接受区域（可撤销）">清理区域</button>
      </div>
      <p class="muted tiny">
        面积按像素统计（不是百分比），阈值填 0 视为关闭。清理区域整批只占一个 Ctrl+Z。
      </p>
      <p class="muted tiny">
        负点修正(R)：先选中区域，点击=保留、Shift+点击=排除；提示点会显示在画布上（白点/红点）。
      </p>
      {#if refineCount > 0}
        <div class="row-line">
          <span class="tiny">提示点 {refineCount} 个</span>
          <button class="btn-mini" onclick={() => { clearRefinePoints(); render(); }}>清除点</button>
        </div>
      {/if}
      <p class="muted tiny">选择(V) 下 Shift+点另一个区域 = 合并进当前选中的区域。</p>
      <p class="muted tiny">
        区域拆分(C)：先选中区域，再在画布上从区域一侧拉到另一侧；松手切成两块，
        最大块保留原编号，其余按新区域处理（整次一个 Ctrl+Z）。
      </p>
      <p class="muted tiny">
        框提示(X)：在目标外面拉一个框，SAM 只在框内抠掩膜；适合边界模糊或一簇同类物体。
      </p>
    </div>

    <!-- 显示 -->
    <div class="section">
      <h4>掩膜显示</h4>
      <label class="check-line">
        <input type="checkbox" bind:checked={ui.segShowOverlay} onchange={() => render()} />
        <span class="tiny">显示已接受区域</span>
      </label>
      <label class="check-line">
        <input type="checkbox" bind:checked={ui.segShowCandidate} onchange={() => render()} />
        <span class="tiny">显示候选</span>
      </label>
      <label class="check-line" title="接受候选时额外记下被覆盖的像素；显示不变，只有 COCO 实例导出会把它们并回原实例。默认关闭。">
        <input type="checkbox" bind:checked={ui.segStrictOverlap} />
        <span class="tiny">严格重叠：保留被遮挡像素（COCO 导出用）</span>
      </label>
      <div class="row-line">
        <label class="tiny" for="seg-overlay-opacity">不透明度</label>
        <input id="seg-overlay-opacity" type="range" min="0.1" max="1" step="0.05" bind:value={ui.segOverlayOpacity} oninput={() => render()} />
        <span class="tiny">{Math.round(ui.segOverlayOpacity * 100)}%</span>
      </div>
      <div class="row-line">
        <label class="tiny" for="seg-overlay-mode">着色</label>
        <select id="seg-overlay-mode" bind:value={ui.segOverlayMode} onchange={() => render()}>
          <option value="instance">按实例</option>
          <option value="class">按类别</option>
        </select>
      </div>
    </div>

    <!-- 点提示类别 -->
    <div class="section">
      <h4>点提示类别（B 键）</h4>
      <div class="chips">
        {#each ui.segClasses as c}
          <button class="chip small" class:active={ui.segActiveClass === c}
            style="border-color:{colorOf(c)}" onclick={() => usePointClass(c)}>{c}</button>
        {/each}
      </div>
    </div>

    <!-- 类别管理 -->
    <div class="section">
      <h4>类别</h4>
      <div class="row-line">
        <input class="text-input" type="text" placeholder="新增类别（英文更准）" bind:value={newClass}
          onkeydown={(e) => { if (e.key === 'Enter') addClass(); }} />
        <button class="btn-mini" onclick={addClass}>+</button>
      </div>
      <p class="muted tiny">分割模式的类别表独立于检测/分类，不会改动它们的 classes。</p>
    </div>

    <!-- 导出 -->
    <div class="section">
      <h4>导出</h4>
      <select class="text-input" bind:value={ui.segExportFormat}>
        {#each SEG_EXPORT_FORMATS as f}
          <option value={f.value}>{f.label}</option>
        {/each}
      </select>
      <p class="muted tiny">{describeMasks()}</p>
      <div class="row-line">
        <button class="btn-mini primary" onclick={props.onExportCurrent} disabled={regions.length === 0}>导出当前图</button>
        <button class="btn-mini" onclick={props.onBatchExport} disabled={regions.length === 0 && getImagesWithMasks().length === 0}>批量导出</button>
      </div>
      {#if ui.segExportFormat === 'seg_instances'}
        <p class="muted tiny">单图「另存为」只能落一个文件 → 只写索引图；逐实例 PNG + 清单请用**批量导出**。</p>
      {:else if ui.segExportFormat === 'seg_coco'}
        <p class="muted tiny">COCO 只写「实例」区域；road/sky 这类整片(stuff)不进实例 JSON。</p>
      {:else if ui.segExportFormat === 'seg_cityscapes'}
        <p class="muted tiny">写 trainId(0..18)；未标注像素与未映射类别都写 255(void)，不会写成 0(road)。</p>
        {#if unmapped.length > 0}
          <p class="muted tiny warn-text">未映射类别（会变成 void）：{unmapped.join('、')}</p>
        {/if}
      {:else if ui.segExportFormat === 'seg_unet'}
        <p class="muted tiny">单通道灰度，0=背景，k=类别表里的第 k 个（1-based）。</p>
      {:else if ui.segExportFormat === 'seg_yolo'}
        <p class="muted tiny">
          每图一个 txt：<code>class x1 y1 x2 y2 …</code>（归一化多边形，ultralytics YOLO-seg）。
          批量导出会额外写 classes.txt；每个区域只取主连通块。
        </p>
      {/if}
    </div>

    <!-- 快捷键 -->
    <div class="section">
      <h4>快捷键</h4>
      <p class="muted tiny">
        V 选择区域 · T 文本提示 · B 点提示（Shift = 负点）· X 框提示<br />
        W 画笔 · E 橡皮 · R 负点修正 · C 区域拆分<br />
        Enter 接受第一个候选 · Backspace 丢弃候选（未选中区域时）<br />
        数字键 1~9 给选中区域换类别 · Delete 删除选中区域<br />
        Ctrl+Z / Ctrl+Y 掩膜撤销重做 · 滚轮缩放 · 中键或 Alt+拖 平移
      </p>
    </div>
  </div>
</div>

<style>
  .seg-panel {
    width: 300px; min-width: 300px;
    background: var(--bg-secondary);
    border-left: 1px solid var(--border);
    display: flex; flex-direction: column;
    z-index: 10;
  }
  .seg-header {
    padding: 14px 16px 12px;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between;
  }
  .seg-header h3 {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    text-transform: uppercase;
    color: var(--text-secondary);
    letter-spacing: 0.8px;
  }
  .close-btn {
    background: none; border: none; color: var(--text-secondary);
    font-size: 18px; cursor: pointer; line-height: 1; padding: 2px 6px;
    border-radius: var(--radius-sm);
  }
  .close-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
  .seg-content { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 14px; }
  .seg-content::-webkit-scrollbar { width: 4px; }
  .seg-content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  .section { margin-bottom: 16px; }
  .section h4 {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px;
    color: var(--text-muted); margin-bottom: 8px;
    padding-bottom: 5px; border-bottom: 1px solid var(--border);
  }
  .muted { color: var(--text-muted); }
  .tiny { font-size: 11px; }
  .warn-text { color: var(--accent-orange, #fbbf24); }
  .row-line { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
  .check-line { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; cursor: pointer; }
  .text-input {
    width: 100%; box-sizing: border-box;
    background: var(--bg-tertiary); border: 1px solid var(--border);
    color: var(--text-primary); border-radius: var(--radius-sm);
    padding: 6px 8px; font-size: 12px; margin-bottom: 6px;
    font-family: inherit;
  }
  .text-input:focus { outline: none; border-color: var(--accent-blue); }
  .num-input {
    width: 62px; background: var(--bg-tertiary); border: 1px solid var(--border);
    color: var(--text-primary); border-radius: var(--radius-sm);
    padding: 4px 6px; font-size: 12px;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); flex: none; }
  .dot.ok { background: #3fb950; }
  .dot.warn { background: #d2991d; }

  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .chip {
    background: var(--bg-tertiary); color: var(--text-secondary);
    border: 1px solid var(--border); border-left-width: 3px;
    border-radius: 10px; padding: 2px 8px; font-size: 11px; cursor: pointer;
    font-family: inherit;
  }
  .chip:hover { color: var(--text-primary); background: var(--bg-hover); }
  .chip.small { padding: 1px 7px; }
  .chip.active { color: var(--text-primary); background: var(--bg-active, var(--bg-hover)); box-shadow: inset 0 0 0 1px var(--accent-blue); }

  .list { display: flex; flex-direction: column; gap: 3px; max-height: 260px; overflow-y: auto; }
  .bar { height: 4px; background: var(--bg-tertiary); border-radius: 2px; overflow: hidden; margin-bottom: 8px; }
  .bar-fill { height: 100%; background: var(--accent-blue, #58a6ff); transition: width 0.2s; }
  .item {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 6px; border-radius: var(--radius-sm);
    background: var(--bg-tertiary); font-size: 11px; color: var(--text-secondary);
  }
  .item.region { cursor: pointer; }
  .item.region:hover { background: var(--bg-hover); }
  .item.sel { box-shadow: inset 0 0 0 1px var(--accent-blue); color: var(--text-primary); }
  .item .idx { font-family: var(--font-mono); color: var(--text-muted); }
  .item .cls { max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
  .kind {
    font-size: 9px; padding: 0 4px; border-radius: 3px;
    background: rgba(88,166,255,0.18); color: var(--accent-blue, #58a6ff);
  }
  .kind.stuff { background: rgba(63,185,80,0.18); color: #3fb950; }
  .cls-select {
    background: transparent; border: 1px solid transparent; color: inherit;
    font-size: 11px; max-width: 100px; font-family: inherit;
  }
  .cls-select:hover { border-color: var(--border); }
  .btn-mini {
    background: var(--bg-tertiary); border: 1px solid var(--border);
    color: var(--text-secondary); border-radius: var(--radius-sm);
    padding: 3px 8px; font-size: 11px; cursor: pointer; font-family: inherit;
  }
  .btn-mini:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-hover); }
  .btn-mini:disabled { opacity: 0.35; cursor: not-allowed; }
  .btn-mini.primary { border-color: rgba(88,166,255,0.5); color: var(--accent-blue, #58a6ff); }
  .btn-mini.danger { border-color: rgba(248,81,73,0.4); color: var(--accent-red, #f85149); }
  .btn-icon {
    background: none; border: none; cursor: pointer; font-size: 11px;
    color: var(--text-muted); padding: 0 3px; line-height: 1;
  }
  .btn-icon:hover { color: var(--text-primary); }
  .btn-icon.ok:hover { color: #3fb950; }
  .btn-icon.no:hover { color: #f85149; }
</style>
