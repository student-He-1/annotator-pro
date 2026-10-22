<script lang="ts">
  import { t } from '$lib/i18n.svelte';
  import { ui, setTool, canUndo, canRedo, isModified } from '$lib/state.svelte';
  import { canUndoMask, canRedoMask } from '$lib/segmentation/store.svelte';
  import { fitToScreen } from '$lib/canvas/engine.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    onToggleSidebar: () => void;
    onToggleProps: () => void;
    onUndo: () => void;
    onRedo: () => void;
    /** 立刻保存标注（Ctrl+S 同款）。自动保存仍在，这个按钮只是让它可控、可确认 */
    onSaveAnnotations: () => void;
    onDelete: () => void;
    onCopy: () => void;
    onExport: () => void;
    onImport: () => void;
    onSaveProject: () => void;
    onOpenProject: () => void;
    onDatasetSplit: () => void;
    onQualityCheck: () => void;
    onYoloAnnotation: () => void;
    onSamAnnotation: () => void;
    /** 顶部「模型状态」面板：三种工作模式共用一个入口 */
    onModels: () => void;
    onStatistics: () => void;
    onImageQuality: () => void;
    onBatchOps: () => void;
    onSettings: () => void;
    onToggleLang: () => void;
    onToggleTheme: () => void;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onFit: () => void;
    imageInfo: string;
  }
  let props: Props = $props();

  const tools: { id: string; icon: string; label: string; key: string }[] = [
    { id: 'select', icon: 'pointer', label: 'selectTool', key: 'V' },
    { id: 'rect', icon: 'square', label: 'rectTool', key: 'R' },
    { id: 'polygon', icon: 'polygon', label: 'polygonTool', key: 'P' },
    { id: 'rotated', icon: 'rotate', label: 'rotatedTool', key: 'O' },
    { id: 'keypoint', icon: 'keypoint', label: 'keypointTool', key: 'K' },
    { id: 'magicwand', icon: 'wand', label: 'magicWandTool', key: 'W' },
    { id: 'sam', icon: 'sam', label: 'samTool', key: 'M' },
  ];

  /** 分割模式的工具组（第三个模式）。
   *  label 直接写中文：i18n 表里没有这三项，没必要为它改共用词表。 */
  const segTools: { id: string; icon: string; label: string; key: string }[] = [
    { id: 'seg_select', icon: 'pointer', label: '选择区域 (V)', key: 'V' },
    { id: 'seg_text', icon: 'sam', label: '文本提示 (T)', key: 'T' },
    { id: 'seg_point', icon: 'keypoint', label: '点提示 (B)', key: 'B' },
    { id: 'seg_brush', icon: 'wand', label: '画笔 (W)', key: 'W' },
    { id: 'seg_eraser', icon: 'trash', label: '橡皮 (E)', key: 'E' },
    { id: 'seg_refine', icon: 'sparkles', label: '负点修正 (R)', key: 'R' },
    { id: 'seg_split', icon: 'scissors', label: '区域拆分 (C)', key: 'C' },
    { id: 'seg_box', icon: 'square', label: '框提示 (X)', key: 'X' },
  ];

  /** 工具栏提示里的键位跟着设置里改过的快捷键走。
   *  否则在设置里把快捷键改掉之后，工具栏还印着旧的 V/R/P，用户会以为没生效。 */
  function keyLabel(id: string, fallback: string): string {
    const k = (ui.shortcuts as unknown as Record<string, string | undefined>)[id];
    if (!k || k.includes('+')) return fallback;
    return k.toUpperCase();
  }
</script>

<div class="toolbar">
  <button class="icon-btn" onclick={props.onToggleSidebar} title="切换侧边栏">
    <Icon name="panel-left" size={16} />
  </button>
  <button class="icon-btn" onclick={props.onToggleProps} title="切换属性面板">
    <Icon name="panel-right" size={16} />
  </button>
  <div class="divider"></div>

  {#if ui.workMode === 'segmentation'}
    {#each segTools as tool}
      <button class="tool-btn" class:active={ui.currentTool === tool.id} data-tool={tool.id}
        onclick={() => setTool(tool.id as any)} title={tool.label}>
        <Icon name={tool.icon} size={17} />
        <span class="tooltip">{tool.label}</span>
      </button>
    {/each}
  {:else}
    {#each tools as tool}
      {#if ui.workMode === 'detection' || tool.id === 'select'}
      <button class="tool-btn" class:active={ui.currentTool === tool.id} data-tool={tool.id}
        onclick={() => setTool(tool.id as any)} title={`${t(tool.label)} (${keyLabel(tool.id, tool.key)})`}>
        <Icon name={tool.icon} size={17} />
        <span class="tooltip">{t(tool.label)} {keyLabel(tool.id, tool.key)}</span>
      </button>
      {/if}
    {/each}
  {/if}

  <div class="divider"></div>
  <button class="icon-btn" onclick={props.onUndo} title={`${t('undo')} (Ctrl+Z)`}
    disabled={ui.workMode === 'segmentation' ? !canUndoMask() : !canUndo()}>
    <Icon name="undo" size={16} />
  </button>
  <button class="icon-btn" onclick={props.onRedo} title={`${t('redo')} (Ctrl+Y)`}
    disabled={ui.workMode === 'segmentation' ? !canRedoMask() : !canRedo()}>
    <Icon name="redo" size={16} />
  </button>

  <div class="divider"></div>
  <!-- 保存标注：自动保存照旧，这个按钮 = 立刻存 + 给一个明确反馈。
       未保存时按钮变黄，和状态栏的「未保存」是同一份数据。
       分割模式也走这里：掩膜由 segmentation/store 注册的钩子一并落盘（三种模式同一套语义）。 -->
  <button class="icon-btn save-annot-btn" class:dirty={isModified()}
    onclick={props.onSaveAnnotations}
    title={`保存标注 (Ctrl+S)${isModified() ? ' · 有未保存改动' : ' · 已是最新'}`}>
    <Icon name="save-check" size={16} />
  </button>

  <div class="divider"></div>
  <button class="icon-btn" onclick={props.onZoomIn} title={t('zoomIn')}>
    <Icon name="zoom-in" size={16} />
  </button>
  <span class="zoom-info">{Math.round(ui.zoom * 100)}%</span>
  <button class="icon-btn" onclick={props.onZoomOut} title={t('zoomOut')}>
    <Icon name="zoom-out" size={16} />
  </button>
  <button class="icon-btn" onclick={props.onFit} title={t('fitScreen')}>
    <Icon name="fit" size={16} />
  </button>

  <!-- 删除/复制只对「选中的标注」有意义；分类模式里 annotation 永远是空的，藏起来免得点了没反应 -->
  {#if ui.workMode === 'detection'}
    <div class="divider"></div>
    <button class="icon-btn" onclick={props.onDelete} title={t('delete')}>
      <Icon name="trash" size={16} />
    </button>
    <button class="icon-btn" onclick={props.onCopy} title={t('copy')}>
      <Icon name="copy" size={16} />
    </button>
  {/if}

  <div class="divider"></div>
  <button class="icon-btn" onclick={props.onExport}
    title={ui.workMode === 'classification'
      ? '导出分类标签 CSV'
      : ui.workMode === 'segmentation' ? '导出分割掩膜' : t('batchExportBtn')}>
    <Icon name="download" size={16} />
  </button>
  <!-- 导入 VOC/COCO/YOLO 是往 annotations 里写框，分类模式/分割模式下导入进来也看不见，藏掉 -->
  {#if ui.workMode === 'detection'}
    <button class="icon-btn" onclick={props.onImport} title={t('importSuccess')}>
      <Icon name="upload" size={16} />
    </button>
  {/if}

  <div class="divider"></div>
  <button class="icon-btn" onclick={props.onSaveProject} title="保存工程">
    <Icon name="save" size={16} />
  </button>
  <button class="icon-btn" onclick={props.onOpenProject} title="打开工程">
    <Icon name="folder-open" size={16} />
  </button>

  <div class="divider"></div>
  <!-- 数据集划分已按模式取数（检测=标注 / 分类=标签 / 分割=掩膜区域），三种模式都可用 -->
  <button class="icon-btn" onclick={props.onDatasetSplit} title="数据集划分">
    <Icon name="pie-chart" size={16} />
  </button>
  {#if ui.workMode === 'detection'}
  <button class="icon-btn" onclick={props.onQualityCheck} title="标注质量校验">
    <Icon name="check" size={16} />
  </button>
  <button class="icon-btn" onclick={props.onYoloAnnotation} title="YOLO预标注">
    <Icon name="sparkles" size={16} />
  </button>
  <button class="icon-btn" onclick={props.onSamAnnotation} title="SAM智能分割">
    <Icon name="sam" size={16} />
  </button>
  {/if}
  <button class="icon-btn" onclick={props.onStatistics} title="标注统计">
    <Icon name="chart" size={16} />
  </button>
  <button class="icon-btn" onclick={props.onImageQuality} title="图片质量筛查">
    <Icon name="image" size={16} />
  </button>
  {#if ui.workMode !== 'segmentation'}
  <button class="icon-btn" onclick={props.onBatchOps} title="批量操作">
    <Icon name="layers" size={16} />
  </button>
  {/if}

  <div class="divider"></div>
  <!-- 模型状态：三端复用同一入口。小圆点跟着后端状态变色（绿=已就绪，黄=加载中） -->
  <button class="icon-btn models-btn" onclick={props.onModels} title="模型状态（SAM3 后端 / YOLO ONNX / 按需模型）">
    <Icon name="cpu" size={16} />
    <span class="model-dot"
      class:ready={ui.samBackendState === 'ready'}
      class:busy={ui.samBackendState === 'starting' || ui.samBackendState === 'loading'}
      class:error={ui.samBackendState === 'error'}></span>
  </button>
  <div class="divider"></div>
  <button class="icon-btn" onclick={props.onSettings} title={t('settings')}>
    <Icon name="settings" size={16} />
  </button>
  <button class="icon-btn" onclick={() => { ui.showModeSelect = true; }} title="切换工作模式">
    <Icon name="mode" size={16} />
  </button>
  <button class="icon-btn" onclick={props.onToggleLang} title={t('language')}>
    <Icon name="globe" size={16} />
  </button>
  <button class="icon-btn" onclick={props.onToggleTheme} title={ui.theme === 'dark' ? '切换浅色主题' : '切换深色主题'}>
    <Icon name={ui.theme === 'dark' ? 'sun' : 'moon'} size={16} />
  </button>

  <div style="flex:1"></div>
  <span class="image-info">{props.imageInfo}</span>
</div>

<style>
  .toolbar {
    display: flex; align-items: center; gap: 2px; padding: 8px 12px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
    backdrop-filter: blur(10px);
  }
  .divider {
    width: 1px; height: 20px;
    background: var(--border);
    margin: 0 6px;
  }
  .icon-btn {
    width: 32px; height: 32px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-secondary);
    border-radius: var(--radius-md);
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all var(--transition-fast);
    position: relative;
  }
  .icon-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    transform: translateY(-1px);
  }
  .icon-btn:active {
    background: var(--bg-active);
    transform: translateY(0);
  }
  .icon-btn:disabled { opacity: 0.35; cursor: not-allowed; transform: none; }
  .icon-btn:disabled:hover { background: transparent; color: var(--text-secondary); transform: none; }

  /* 模型状态小圆点：叠在图标右下角，不占额外宽度 */
  .models-btn { position: relative; }
  .model-dot {
    position: absolute; right: 5px; bottom: 4px;
    width: 5px; height: 5px; border-radius: 50%;
    background: var(--text-muted);
  }
  .model-dot.ready { background: #3fb950; box-shadow: 0 0 4px rgba(63,185,80,0.8); }
  .model-dot.busy { background: #d2991d; animation: model-pulse 1.1s ease-in-out infinite; }
  .model-dot.error { background: #f85149; }
  @keyframes model-pulse { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }

  /* 「保存标注」按钮：有未保存改动时点亮，和状态栏那个黄点同源（都读 imageModified） */
  .save-annot-btn.dirty {
    color: #d2991d;
    border-color: rgba(210,153,29,0.45);
    background: rgba(210,153,29,0.10);
  }
  .save-annot-btn.dirty:hover {
    color: #f0b429;
    background: rgba(210,153,29,0.18);
  }

  .tool-btn {
    width: 34px; height: 34px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-secondary);
    border-radius: var(--radius-md);
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all var(--transition-fast);
    position: relative;
  }
  .tool-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .tool-btn.active {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    box-shadow: inset 0 0 0 1px var(--border-light);
  }
  .tool-btn[data-tool="select"].active {
    background: rgba(154,167,184,0.15);
    color: var(--text-primary);
    box-shadow: inset 0 0 0 1px rgba(154,167,184,0.3);
  }
  .tool-btn[data-tool="rect"].active {
    background: rgba(77,163,255,0.15);
    color: var(--accent-blue);
    box-shadow: inset 0 0 0 1px rgba(77,163,255,0.35);
  }
  .tool-btn[data-tool="polygon"].active {
    background: rgba(74,222,128,0.15);
    color: var(--accent-green);
    box-shadow: inset 0 0 0 1px rgba(74,222,128,0.35);
  }
  .tool-btn[data-tool="rotated"].active {
    background: rgba(251,191,36,0.15);
    color: var(--accent-orange);
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.35);
  }
  .tool-btn[data-tool="keypoint"].active {
    background: rgba(248,113,113,0.15);
    color: var(--accent-red);
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.35);
  }
  .tool-btn[data-tool="magicwand"].active {
    background: rgba(167,139,250,0.15);
    color: var(--accent-purple);
    box-shadow: inset 0 0 0 1px rgba(167,139,250,0.35);
  }
  .tool-btn[data-tool="sam"].active {
    background: rgba(54,209,196,0.15);
    color: var(--accent-cyan);
    box-shadow: inset 0 0 0 1px rgba(54,209,196,0.35);
  }

  .tooltip {
    position: absolute; bottom: -32px; left: 50%;
    transform: translateX(-50%) translateY(-4px);
    font-size: var(--text-xs);
    white-space: nowrap;
    background: var(--bg-tertiary);
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    opacity: 0;
    pointer-events: none;
    transition: all var(--transition-fast);
    z-index: 1000;
    color: var(--text-primary);
    box-shadow: var(--shadow-md);
    font-weight: var(--weight-medium);
  }
  .tool-btn:hover .tooltip {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  .zoom-info {
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-family: var(--font-mono);
    padding: 0 8px;
    min-width: 48px;
    text-align: center;
    font-weight: var(--weight-medium);
  }
  .image-info {
    font-size: var(--text-xs);
    color: var(--text-muted);
    padding-right: 8px;
    font-family: var(--font-mono);
  }
</style>








