/// <reference types="vite/client" />

// File System Access API 的目录选择器：TS 的 lib.dom 里还没声明它，
// 但 Chromium（含 WebView2）实现了。这里补声明，避免 App.svelte 里
// window.showDirectoryPicker 四处报「属性不存在」。
interface Window {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<{
    getFileHandle(name: string, options?: { create?: boolean }): Promise<{
      createWritable(): Promise<{ write(data: Blob | string): Promise<void>; close(): Promise<void> }>;
    }>;
  }>;
}
