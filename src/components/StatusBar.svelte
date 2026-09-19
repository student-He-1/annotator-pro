<script lang="ts">
  import { t } from '$lib/i18n.svelte';
  import { ui, getCurrentAnnotations, images, isModified } from '$lib/state.svelte';

  let mousePos = $state({ x: 0, y: 0 });

  export function updateMousePos(x: number, y: number) {
    mousePos = { x, y };
  }

  const currentName = $derived(
    ui.currentImageIndex >= 0 && images[ui.currentImageIndex] ? images[ui.currentImageIndex].name : t('noFile')
  );
  const annCount = $derived(
    ui.workMode === 'classification' 
      ? (ui.currentImageIndex >= 0 && images[ui.currentImageIndex] 
        ? (ui.imageLabels[images[ui.currentImageIndex].name]?.length || 0) 
        : 0)
      : getCurrentAnnotations().length
  );
  const modified = $derived(isModified());
</script>

<div class="status-bar">
  <div class="status-left">
    <span>{currentName}</span>
    <span>{annCount} {t('totalAnnotations')}</span>
  </div>
  <div class="status-right">
    <span>x: {mousePos.x.toFixed(0)}, y: {mousePos.y.toFixed(0)}</span>
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
