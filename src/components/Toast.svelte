<script lang="ts">
  import { ui } from '$lib/state.svelte';
</script>

{#if ui.toastMessages.length > 0}
  <div class="toast-container">
    {#each ui.toastMessages as toast (toast.id)}
      <div class="toast {toast.type}">{toast.msg}</div>
    {/each}
  </div>
{/if}

<style>
  .toast-container {
    position: fixed; bottom: 40px; right: 20px; z-index: 2000;
    display: flex; flex-direction: column; gap: 8px;
  }
  .toast {
    padding: 10px 16px; border-radius: 6px; font-size: 12px; color: var(--text-primary);
    background: var(--bg-tertiary); border: 1px solid var(--border);
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    animation: slideIn 0.2s ease;
  }
  .toast.success { border-color: #3fb950; }
  .toast.error { border-color: #f85149; }
  .toast.info { border-color: #58a6ff; }
  @keyframes slideIn { from { transform: translateX(100%); opacity:0; } to { transform: translateX(0); opacity:1; } }
</style>