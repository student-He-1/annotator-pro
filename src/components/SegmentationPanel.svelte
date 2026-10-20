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
    reviewSweepClass,
  } from '$lib/segmentation/store.svelte';
  import { SEG_PRESETS } from '$lib/segmentation/presets';
  import { describeMasks, getUnmappedCityscapesClasses, SEG_EXPORT_FORMATS } from '$lib/export/segmentation-export';

  const colorOf = colorOfSegClass;

  interface Props {
    onExportCurrent: () => void;
    onBatchExport: () => void;
    onClose: () => void;
  }
  let props: Props = $props();

  let newClass = $state('');
  let busy = $state(false);

  const curName = $derived(images[ui.currentImageIndex]?.name || '');
  // $derived 里读 ui.maskRev 才会在掩膜变化时重算（掩膜本体不在 $state 里）
  const regions = $derived((ui.maskRev, curName ? getRegions(curName) : []));
  const cands = $derived((ui.maskRev, getCandidates()));
  const selected = $derived(ui.segSelectedRegion);
  /** Cityscapes 语义图导出前要提醒的「映射不到」类别（它们会被写成 void=255） */
  const unmapped = $derived((ui.maskRev, curName ? getUnmappedCityscapesClasses(getImageMask(curName)) : []));

  async function startSweep() {
    if (busy) return;
    busy = true;
    try {
      // 传 render 进去：扫描是逐词合并的，每合并完一个词就重画一次，边扫边能看到掩膜
      await runClassSweep(() => render());
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

  function doAccept(k: number, className: string, kind: 'instance' | 'stuff') {
    acceptCandidate(k, className, kind);
    render();
  }

  function doAcceptAll() {
    acceptAllCandidates();
    render();
  }

  function doDiscard(k: number) {
    discardCandidate(k);
    render();
  }

  function doRegionClick(ordinal: number) {
    selectRegion(ui.segSelectedRegion === ordinal ? 0 : ordinal);
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
    </div>

    <!-- 文本提示：主力工作流 -->
    <div class="section">
      <h4>文本提示（回车出候选）</h4>
      <input class="text-input" type="text" placeholder="任意英文词，如 car / road / sidewalk"
        bind:value={ui.segText} onkeydown={onPromptKey} />
      <div class="row-line">
        <label class="tiny">阈值</label>
        <input class="num-input" type="number" step="0.05" min="0.05" max="0.95" bind:value={ui.segConfThreshold} />
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
        <label class="tiny">自动接受 ≥</label>
        <input class="num-input" type="number" step="0.05" min="0.05" max="0.99" bind:value={ui.segSweepAutoAccept} />
        <span class="muted tiny">（低于它、且高于上面的请求阈值 → 待复核）</span>
      </div>
      {#if ui.segSweepRunning}
        <div class="row-line">
          <span class="tiny">扫描中 {ui.segSweepDone}/{ui.segSweepTotal} · {ui.segSweepCurrent || '…'}</span>
          <button class="btn-mini danger" onclick={() => cancelClassSweep()}>取消</button>
        </div>
        <div class="bar"><div class="bar-fill" style="width:{ui.segSweepTotal ? Math.round(ui.segSweepDone / ui.segSweepTotal * 100) : 0}%"></div></div>
      {:else}
        <div class="row-line">
          <button class="btn-mini primary" onclick={startSweep}
            disabled={ui.segSweepClasses.length === 0 || busy}>开始扫描（{ui.segSweepClasses.length} 类）</button>
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
            <div class="item cand">
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
            <div class="item region" class:sel={selected === r.ordinal} onclick={() => doRegionClick(r.ordinal)}>
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
      <div class="row-line">
        <label class="tiny">不透明度</label>
        <input type="range" min="0.1" max="1" step="0.05" bind:value={ui.segOverlayOpacity} oninput={() => render()} />
        <span class="tiny">{Math.round(ui.segOverlayOpacity * 100)}%</span>
      </div>
      <div class="row-line">
        <label class="tiny">着色</label>
        <select bind:value={ui.segOverlayMode} onchange={() => render()}>
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
        <button class="btn-mini" onclick={props.onBatchExport} disabled={regions.length === 0 && (ui.maskTotal || 0) === 0}>批量导出</button>
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
      {/if}
    </div>

    <!-- 快捷键 -->
    <div class="section">
      <h4>快捷键</h4>
      <p class="muted tiny">
        V 选择区域 · T 文本提示 · B 点提示（Shift = 负点）<br />
        Delete 删除选中区域 · Ctrl+Z / Ctrl+Y 掩膜撤销重做<br />
        滚轮缩放 · 中键或 Alt+拖 平移
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
