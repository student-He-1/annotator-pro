<script lang="ts">
  import { t, getLang, setLang } from '$lib/i18n.svelte';
  import { ui } from '$lib/state.svelte';
  import { SKELETON_TEMPLATES } from '$lib/skeletons';
  import type { Language, ShortcutMap } from '$lib/types';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  const shortcutNames: Record<string, string> = {
    select: 'selectTool', rect: 'rectTool', polygon: 'polygonTool',
    rotated: 'rotatedTool', keypoint: 'keypointTool',
    undo: 'undo', redo: 'redo', delete: 'delete', copy: 'copy',
    zoomIn: 'zoomIn', zoomOut: 'zoomOut', fit: 'fitScreen', save: 'save',
  };

  function handleLangSwitch(lang: Language) {
    setLang(lang);
  }

  function startRecording(key: string) {
    if (ui.recordingShortcut) {
      ui.recordingShortcut = null;
      return;
    }
    ui.recordingShortcut = key;
  }

  function resetShortcuts() {
    ui.shortcuts = {
      select: 'v', rect: 'r', polygon: 'p', rotated: 'o', keypoint: 'k',
      undo: 'ctrl+z', redo: 'ctrl+y', redoAlt: 'ctrl+shift+z',
      delete: 'delete', copy: 'ctrl+d',
      zoomIn: 'ctrl+=', zoomOut: 'ctrl+-', fit: 'ctrl+0',
      save: 'ctrl+s',
    };
  }

  const entries = $derived(
    Object.entries(ui.shortcuts).filter(([k]) => k !== 'redoAlt')
  );
</script>

<div class="overlay" onclick={onClose}>
  <div class="modal" onclick={(e) => e.stopPropagation()}>
    <h3>{t('settings')}</h3>

    <div class="section">
      <h4>{t('language')}</h4>
      <div class="lang-buttons">
        <button class="btn-sm" class:primary={getLang() === 'zh'} onclick={() => handleLangSwitch('zh')}>中文</button>
        <button class="btn-sm" class:primary={getLang() === 'en'} onclick={() => handleLangSwitch('en')}>English</button>
      </div>
    </div>

    <div class="section">
      <h4>关键点骨架</h4>
      <select class="skeleton-select" value={ui.skeletonId} onchange={(e) => ui.skeletonId = (e.target as HTMLSelectElement).value}>
        {#each SKELETON_TEMPLATES as skel}
          <option value={skel.id}>{skel.name}</option>
        {/each}
      </select>
      <p class="skeleton-hint">选择后关键点标注会自动绘制骨架连线</p>
    </div>

    <div class="section">
      <h4>{t('ui.shortcuts')}</h4>
      {#each entries as [key, shortcut]}
        <div class="shortcut-row">
          <span class="name">{t(shortcutNames[key] || key)}</span>
          <span class="key" class:recording={ui.recordingShortcut === key}
            onclick={() => startRecording(key)}>
            {ui.recordingShortcut === key ? t('recording') : shortcut.split('+').map(k => k.charAt(0).toUpperCase() + k.slice(1)).join('+')}
          </span>
        </div>
      {/each}
    </div>

    <div class="actions">
      <button class="btn-sm" onclick={resetShortcuts}>{t('reset')}</button>
      <button class="btn-sm btn-primary" onclick={onClose}>{t('save')}</button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 1000;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(4px);
  }
  .modal {
    background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px;
    padding: 24px; min-width: 400px; max-width: 600px; max-height: 80vh;
    overflow-y: auto; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  }
  .modal h3 { font-size: 16px; margin-bottom: 16px; color: var(--text-primary); }
  .section { margin-bottom: 16px; }
  .section h4 {
    font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
    color: var(--text-muted); margin-bottom: 8px;
  }
  .lang-buttons { display: flex; gap: 8px; }
  .skeleton-select {
    width: 100%; padding: 8px 10px; background: var(--bg-tertiary); border: 1px solid var(--border);
    border-radius: 4px; color: var(--text-primary); font-size: 12px; cursor: pointer;
  }
  .skeleton-select:focus { outline: none; border-color: #58a6ff; }
  .skeleton-hint { font-size: 10px; color: var(--text-muted); margin-top: 6px; }
  .shortcut-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 12px;
  }
  .shortcut-row .name { color: var(--text-secondary); }
  .key {
    padding: 2px 8px; background: var(--bg-tertiary); border: 1px solid var(--border);
    border-radius: 4px; font-family: 'JetBrains Mono', monospace;
    font-size: 11px; color: var(--text-primary); cursor: pointer; min-width: 28px; text-align: center;
  }
  .key.recording { border-color: #d2991d; animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }
  .btn-sm {
    padding: 6px 12px; font-size: 11px; border: 1px solid var(--border);
    background: var(--bg-tertiary); color: var(--text-secondary); border-radius: 4px; cursor: pointer;
    transition: all 150ms;
  }
  .btn-sm:hover { background: var(--border); color: var(--text-primary); }
  .btn-primary { background: #58a6ff; color: #fff; border-color: #58a6ff; }
  .btn-primary:hover { background: #4090e0; }
</style>