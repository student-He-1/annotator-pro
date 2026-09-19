import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      '$lib': fileURLToPath(new URL('./src/lib', import.meta.url)),
    },
  },
  clearScreen: false,
  build: {
    chunkSizeWarningLimit: 30000,
    rollupOptions: {
      output: {
        // onnxruntime-web 独立分包，避免拖慢首屏
        manualChunks: {
          'onnxruntime': ['onnxruntime-web'],
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
});
