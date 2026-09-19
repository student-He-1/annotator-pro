<script lang="ts">
  import { t } from '$lib/i18n.svelte';
  import { ui, setTool, canUndo, canRedo } from '$lib/state.svelte';
  import { fitToScreen } from '$lib/canvas/engine.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    onToggleSidebar: () => void;
    onToggleProps: () => void;
    onUndo: () => void;
    onRedo: () => void;
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
</script>

<div class="toolbar">
  <button class="icon-btn" onclick={props.onToggleSidebar} title="切换侧边栏">
    <Icon name="panel-left" size={16} />
  </button>
  <button class="icon-btn" onclick={props.onToggleProps} title="切换属性面板">
    <Icon name="panel-right" size={16} />
  </button>
  <div class="divider"></div>

  {#each tools as tool}
    {#if ui.workMode !== 'classification' || tool.id === 'select'}
    <button class="tool-btn" class:active={ui.currentTool === tool.id} data-tool={tool.id}
      onclick={() => setTool(tool.id as any)} title={`${t(tool.label)} (${tool.key})`}>
      <Icon name={tool.icon} size={17} />
      <span class="tooltip">{t(tool.label)} {tool.key}</span>
    </button>
    {/if}
  {/each}

  <div class="divider"></div>
  <button class="icon-btn" onclick={props.onUndo} title={`${t('undo')} (Ctrl+Z)`} disabled={!canUndo()}>
    <Icon name="undo" size={16} />
  </button>
  <button class="icon-btn" onclick={props.onRedo} title={`${t('redo')} (Ctrl+Y)`} disabled={!canRedo()}>
    <Icon name="redo" size={16} />
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

  <div class="divider"></div>
  <button class="icon-btn" onclick={props.onDelete} title={t('delete')}>
    <Icon name="trash" size={16} />
  </button>
  <button class="icon-btn" onclick={props.onCopy} title={t('copy')}>
    <Icon name="copy" size={16} />
  </button>

  <div class="divider"></div>
  <button class="icon-btn" onclick={props.onExport} title={t('batchExportBtn')}>
    <Icon name="download" size={16} />
  </button>
  <button class="icon-btn" onclick={props.onImport} title={t('importSuccess')}>
    <Icon name="upload" size={16} />
  </button>

  <div class="divider"></div>
  <button class="icon-btn" onclick={props.onSaveProject} title="保存工程">
    <Icon name="save" size={16} />
  </button>
  <button class="icon-btn" onclick={props.onOpenProject} title="打开工程">
    <Icon name="folder-open" size={16} />
  </button>

  <div class="divider"></div>
  <button class="icon-btn" onclick={props.onDatasetSplit} title="数据集划分">
    <Icon name="pie-chart" size={16} />
  </button>
  {#if ui.workMode !== 'classification'}
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
  <button class="icon-btn" onclick={props.onBatchOps} title="批量操作">
    <Icon name="layers" size={16} />
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
  .tool-btn:hover .tooltip, .icon-btn:hover .tooltip {
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








