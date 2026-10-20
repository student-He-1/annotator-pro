<script lang="ts">
  import { t } from '$lib/i18n.svelte';
  import { ui, getCurrentAnnotations, images, isModified } from '$lib/state.svelte';

  // 坐标以前是组件局部 state + 一个 updateMousePos() 导出函数，
  // 但没有任何地方调用过它 → 状态栏永远显示 x: 0, y: 0。
  // 现在直接读 Canvas 在 mousemove 里写好的 ui.mouseImg*（图像坐标）。
  const coordText = $derived(
    ui.mouseOverCanvas && ui.currentImage
      ? `x: ${ui.mouseImgX.toFixed(0)}, y: ${ui.mouseImgY.toFixed(0)}`
      : 'x: —, y: —'
  );

  const currentName = $derived(
    ui.currentImageIndex >= 0 && images[ui.currentImageIndex] ? images[ui.currentImageIndex].name : t('noFile')
  );
  const annCount = $derived(
    ui.workMode === 'segmentation'
      ? (ui.maskRev, ui.currentImageIndex >= 0 && images[ui.currentImageIndex]
        ? (ui.maskCounts?.[images[ui.currentImageIndex].name] || 0)
        : 0)
      : ui.workMode === 'classification' 
        ? (ui.currentImageIndex >= 0 && images[ui.currentImageIndex] 
          ? (ui.imageLabels[images[ui.currentImageIndex].name]?.length || 0) 
          : 0)
        : getCurrentAnnotations().length
  );
  // 分割模式：掩膜只随工程文件保存，没有 localStorage 那一层「已保存」语义
  const modified = $derived(
    ui.workMode === 'segmentation'
      ? (ui.maskRev, !!ui.maskDirty[images[ui.currentImageIndex]?.name || ''])
      : isModified()
  );
</script>

<div class="status-bar">
  <div class="status-left">
    <span>{currentName}</span>
    <span>{annCount} {t('totalAnnotations')}</span>
  </div>
  <div class="status-right">
    <span class="coords">{coordText}</span>
    <span>
      <span class="status-dot" class:unsaved={modified} class:saved={ui.currentImageIndex >= 0 && !modified} class:empty={ui.currentImageIndex < 0}></span>
      {modified ? t('unsaved') : ui.currentImageIndex >= 0 ? t('saved') : t('empty')}
    </span>
  </div>
</div>

<style>
  .status-bar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 4px 12px; background: var(--bg-secondary); border-top: 1px solid var(--border);
    font-size: 11px; color: var(--text-muted); font-family: 'JetBrains Mono', monospace; gap: 16px;
  }
  .status-left, .status-right { display: flex; align-items: center; gap: 12px; }
  .status-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
  .status-dot.saved { background: #3fb950; }
  .status-dot.unsaved { background: #d2991d; }
  .status-dot.empty { background: var(--text-muted); }
</style>
