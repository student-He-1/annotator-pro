<script lang="ts">
  import { untrack } from 'svelte';
  import { t, getLang } from '$lib/i18n.svelte';
  import { images, annotations, ui, getTotalAnnotationCount, getImagesWithAnnotations } from '$lib/state.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    onSelectImage: (index: number) => void;
    onImportFolder: () => void;
    onImportFiles: () => void;
    onDeleteImage: (index: number) => void;
  }
  let props: Props = $props();

  const ITEM_HEIGHT = 36;
  const BUFFER = 5;

  let listContainer: HTMLDivElement;
  let scrollTop = $state(0);
  let containerHeight = $state(400);

  const statsText = $derived.by(() => {
    if (images.length === 0) return '';
    if (ui.workMode === 'classification') {
      const imgNames = images.map(i => i.name); const labeled = imgNames.filter(k => (ui.imageLabels[k] || []).length > 0).length;
      const total = imgNames.reduce((s, k) => s + (ui.imageLabels[k] || []).length, 0);
      return `${labeled}/${images.length} 已打标 | ${total} 个标签`;
    }
    return `${getImagesWithAnnotations().length}/${images.length} ${t('annotated')} | ${getTotalAnnotationCount()} ${t('totalAnnotations')}`;
  });

  const totalHeight = $derived(images.length * ITEM_HEIGHT);
  const startIndex = $derived(Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER));
  const endIndex = $derived(Math.min(images.length, Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT) + BUFFER));
  const visibleImages = $derived(images.slice(startIndex, endIndex));
  const offsetY = $derived(startIndex * ITEM_HEIGHT);

  function handleScroll(e: Event) {
    scrollTop = (e.target as HTMLDivElement).scrollTop;
  }

  $effect(() => {
    if (listContainer) {
      containerHeight = listContainer.clientHeight;
      const ro = new ResizeObserver(() => {
        containerHeight = listContainer.clientHeight;
      });
      ro.observe(listContainer);
      return () => ro.disconnect();
    }
  });

  // Auto-scroll to current image when it changes
  $effect(() => {
    const idx = ui.currentImageIndex; // 只依赖 currentImageIndex
    if (listContainer && idx >= 0) {
      // 用 untrack 排除 scrollTop/containerHeight，避免用户滚动时也触发
      untrack(() => {
        const itemTop = idx * ITEM_HEIGHT;
        const itemBottom = itemTop + ITEM_HEIGHT;
        if (itemTop < scrollTop || itemBottom > scrollTop + containerHeight) {
          listContainer.scrollTop = itemTop - containerHeight / 2 + ITEM_HEIGHT / 2;
        }
      });
    }
  });
</script>

<div class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <h2>{t('fileList')}</h2>
    <span class="stats">{statsText}</span>
  </div>
  <div class="drop-area" id="dropArea">
    {t('dropHint')}
  </div>
  <div class="import-buttons">
    <button class="btn-sm" onclick={props.onImportFolder}><Icon name="folder" size={14} /> {t('importFolder')}</button>
    <button class="btn-sm" onclick={props.onImportFiles}><Icon name="image" size={14} /> {t('addFiles')}</button>
  </div>
  <div class="file-list-container" bind:this={listContainer} onscroll={handleScroll}>
    <div class="file-list" style="height:{totalHeight}px">
      <div style="transform:translateY({offsetY}px)">
        {#each visibleImages as img, i (img.name)}
          {@const idx = startIndex + i}
          <div class="file-item" class:active={idx === ui.currentImageIndex}
            class:has-annotations={ui.workMode !== 'classification' && (annotations[img.name]?.length || 0) > 0}
            onclick={() => props.onSelectImage(idx)}
            style="height:{ITEM_HEIGHT}px">
            <Icon name="image" size={14} class="file-icon" />
            <span class="file-name">{img.name}</span>
            <span class="file-badge">{ui.workMode === 'classification' ? (ui.imageLabels[img.name]?.length || 0) : (annotations[img.name]?.length || 0)}</span>
            <button class="delete-btn" onclick={(e) => { e.stopPropagation(); props.onDeleteImage(idx); }} title="删除图片">
              <Icon name="trash" size={12} />
            </button>
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .sidebar {
    width: 280px; min-width: 280px;
    background: var(--bg-secondary);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    z-index: 10;
  }
  .sidebar-header {
    padding: 14px 16px 12px;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .sidebar-header h2 {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.8px;
    text-transform: uppercase;
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .stats {
    font-size: 10px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    white-space: nowrap;
    padding: 2px 8px;
    background: var(--bg-tertiary);
    border-radius: 10px;
  }
  .drop-area {
    padding: 16px 12px;
    margin: 10px;
    border: 2px dashed var(--border);
    border-radius: var(--radius-lg);
    text-align: center;
    color: var(--text-muted);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: all var(--transition-normal);
    line-height: 1.6;
  }
  .drop-area:hover {
    border-color: var(--accent-blue);
    color: var(--accent-blue);
    background: rgba(77,163,255,0.05);
  }
  .import-buttons {
    padding: 0 10px;
    display: flex; gap: 8px;
  }
  .import-buttons .btn-sm {
    flex: 1; text-align: center; padding: 8px 10px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    transition: all var(--transition-fast);
    display: flex; align-items: center; justify-content: center; gap: 6px;
  }
  .import-buttons .btn-sm:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--border-light);
    transform: translateY(-1px);
  }
  .import-buttons .btn-sm:active { transform: translateY(0); }
  .file-list-container {
    flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
    margin-top: 10px;
    padding: 0 6px;
  }
  .file-list-container::-webkit-scrollbar { width: 4px; }
  .file-list-container::-webkit-scrollbar-track { background: transparent; }
  .file-list-container::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
  .file-list { position: relative; }
  .file-item {
    padding: 0 10px;
    display: flex; align-items: center; gap: 8px;
    cursor: pointer;
    border-left: 3px solid transparent;
    border-radius: var(--radius-md);
    transition: all var(--transition-fast);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    box-sizing: border-box;
    margin-bottom: 2px;
    height: 36px;
  }
  .file-item:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }
  .file-item.active {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border-left-color: var(--accent-blue);
    box-shadow: inset 0 0 0 1px var(--border-light);
  }
  .file-icon { flex-shrink: 0; color: var(--text-muted); }
  .file-item.active .file-icon { color: var(--accent-blue); }
  .file-name {
    flex: 1; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
    font-weight: var(--weight-medium);
  }
  .file-badge {
    font-size: 10px; padding: 2px 8px;
    border-radius: 10px;
    background: var(--bg-hover);
    color: var(--text-muted);
    flex-shrink: 0;
    font-weight: var(--weight-semibold);
    font-family: var(--font-mono);
  }
  .has-annotations .file-badge {
    background: rgba(77,163,255,0.15);
    color: var(--accent-blue);
  }
  .delete-btn {
    opacity: 0; flex-shrink: 0;
    width: 22px; height: 22px;
    display: flex; align-items: center; justify-content: center;
    background: transparent; border: none;
    border-radius: var(--radius-sm);
    color: var(--text-muted); cursor: pointer;
    transition: all var(--transition-fast);
  }
  .file-item:hover .delete-btn { opacity: 1; }
  .delete-btn:hover {
    background: rgba(248,113,113,0.15);
    color: var(--accent-red);
  }
</style>






