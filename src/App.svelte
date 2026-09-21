<script lang="ts">
  import { onMount } from 'svelte';
  import { t, initLang, getLang, setLang } from '$lib/i18n.svelte';
  import {
    images, ui, classes, classColors, COLORS,
    selectAnnotation, loadSavedData, saveAnnotations, saveAnnotationsNow, showToast,
    applyTheme, toggleTheme,
    getImagesWithAnnotations, getTotalAnnotationCount,
    classColors as colors, getClassColor, pushHistory,
    annotations, markModified, clearModified,
  } from './lib/state.svelte';
  import { getExportData, getMergedCOCO, downloadFile, exportClassificationCSV, getClassificationCSVContent } from '$lib/export/formats';
  import { exportVisualImageDataUrl } from '$lib/export/visual-export';
  import { saveProjectAs, loadProjectFromFile } from '$lib/project.svelte';
  import { fitToScreen, render } from '$lib/canvas/engine.svelte';
  import { clearCache as clearSamCache, ensureSidecar } from '$lib/sam';
  import type { ImageInfo, ExportFormat } from '$lib/types';

  // Tauri 工具函数：直接尝试调用，失败就返回 null
  async function tauriInvoke(cmd: string, args?: any): Promise<any> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke(cmd, args);
    } catch (e) {
      console.warn('Tauri invoke failed:', cmd, e);
      return null;
    }
  }

  import Toast from './components/Toast.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import Toolbar from './components/Toolbar.svelte';
  import Canvas from './components/Canvas.svelte';
  import PropertiesPanel from './components/PropertiesPanel.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import SettingsModal from './components/SettingsModal.svelte';
  import DatasetSplitModal from './components/DatasetSplitModal.svelte';
  import QualityCheckModal from './components/QualityCheckModal.svelte';
  import YoloAnnotationModal from './components/YoloAnnotationModal.svelte';
  import SamModelModal from './components/SamModelModal.svelte';
  import StatisticsModal from './components/StatisticsModal.svelte';
  import ImageQualityModal from './components/ImageQualityModal.svelte';
  import BatchOperationsModal from './components/BatchOperationsModal.svelte';
  import { parseLabelMe } from './lib/import/labelme';

  let showSettings = $state(false);
  let showDatasetSplit = $state(false);
  let showQualityCheck = $state(false);
  let showYoloModal = $state(false);
  let showSamModal = $state(false);
  let showStatistics = $state(false);
  let showImageQuality = $state(false);
  let showBatchOps = $state(false);
  let sidebarCollapsed = $state(false);
  let propsCollapsed = $state(false);

  let canvasRef = $state<InstanceType<typeof Canvas> | null>(null);
  let statusBarRef = $state<InstanceType<typeof StatusBar> | null>(null);

  // 打开新弹窗时关闭所有其他弹窗，避免弹窗堆积
  function closeAllModals() {
    showSettings = false;
    showDatasetSplit = false;
    showQualityCheck = false;
    showYoloModal = false;
    showSamModal = false;
    showStatistics = false;
    showImageQuality = false;
    showBatchOps = false;
  }

  let imageInfo = $derived(canvasRef?.getImageInfo() ?? '');
  let welcomeVisible = $derived(canvasRef?.getWelcomeVisible() ?? true);

  // ============================================================
  // 选择工作模式
  function selectMode(mode: string) {
    ui.workMode = mode as any;
    ui.showModeSelect = false;
  }

  // Init
  // ============================================================
  // 用 onMount 而非 $effect：loadSavedData 会写入 $state，$effect 中写入会触发自身重跑导致死循环（effect_update_depth_exceeded）
  onMount(async () => {
    try { await ensureSidecar(); } catch(e) { console.warn('sidecar failed', e); }
    initLang();
    loadSavedData();
    applyTheme();
    // 页面关闭/刷新前自动保存，防止数据丢失
    const handleBeforeUnload = () => saveAnnotationsNow();
    window.addEventListener('beforeunload', handleBeforeUnload);

    // Tauri 拖拽功能暂时禁用，先确保应用能启动
    // TODO: 调试 Tauri 文件拖拽

    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  });

  // ============================================================
  // Image loading
  // ============================================================
  // 判断是否为图片文件：优先用 MIME type，为空时按扩展名兜底（部分内核文件夹导入 type 为空）
  function isImageFile(file: File): boolean {
    if (file.type && file.type.startsWith('image/')) return true;
    const ext = file.name.toLowerCase().split('.').pop() || '';
    return ['jpg', 'jpeg', 'png', 'bmp', 'webp', 'gif', 'svg', 'avif', 'ico', 'tiff', 'tif', 'jfif', 'jpe', 'jif', 'wdp', 'jxr', 'hdp'].includes(ext);
  }

  function loadImages(files: FileList) {
    const allFiles = Array.from(files);
    const imageFiles = allFiles.filter(isImageFile);
    const filteredOut = allFiles.length - imageFiles.length;
    
    if (imageFiles.length === 0) {
      showToast(`No image files found (${allFiles.length} files filtered out)`, 'error');
      return;
    }

    // 用完整相对路径去重，但刷新后恢复的空壳图片（dataUrl 为空）不参与去重，重新导入时重新加载
    const fileKey = (f: File) => (f as any).webkitRelativePath || f.name;
    const existingKeys = new Set(images.filter(i => i.dataUrl).map(i => i.name)); // 只对已加载的图片去重
    const newFiles = imageFiles.filter(f => !existingKeys.has(fileKey(f)));
    const dupRemoved = imageFiles.length - newFiles.length;
    
    if (newFiles.length === 0) {
      showToast(`All images already loaded (${dupRemoved} duplicates)`, 'info');
      return;
    }

    const total = newFiles.length;
    showToast(`Loading 0/${total} images...`, 'info');

    const CONCURRENCY = 4;
    let index = 0;
    let loaded = 0;
    let failed = 0;
    const failedNames: string[] = [];
    const restoredNames: string[] = [];

    function loadOne(file: File): Promise<ImageInfo | null> {
      const url = URL.createObjectURL(file);
      // 文件夹导入时用完整相对路径，区分不同子文件夹的同名文件
      const displayName = (file as any).webkitRelativePath || file.name;
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          resolve({
            name: displayName,
            dataUrl: url,
            width: img.width || img.naturalWidth,
            height: img.height || img.naturalHeight,
          });
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          resolve(null);
        };
        img.src = url;
      });
    }

    async function worker() {
      while (index < newFiles.length) {
        const currentIndex = index++;
        const result = await loadOne(newFiles[currentIndex]);
        if (result) {
          // 检查是否已有同名空壳图片（刷新后恢复的），有则替换
          const existingIdx = images.findIndex(i => i.name === result.name && !i.dataUrl);
          if (existingIdx >= 0) {
            images[existingIdx] = result; // 替换空壳
          } else {
            images.push(result);
          }
          loaded++;
          const existingAnns = annotations[result.name];
          const existingLabels = ui.imageLabels[result.name];
          if (ui.workMode === 'classification') {
            if (existingLabels && existingLabels.length > 0) restoredNames.push(result.name);
          } else {
            if (existingAnns && existingAnns.length > 0) restoredNames.push(result.name);
          }
        } else {
          failed++;
          failedNames.push(newFiles[currentIndex].name);
        }
        if (loaded % 5 === 0 || loaded === total) {
          showToast(`Loading ${loaded}/${total} images...`, 'info');
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, newFiles.length) }, () => worker());
    Promise.all(workers).then(() => {
      ui.isLoading = false;
      ui.loadingProgress = 100;
      if (ui.currentImageIndex < 0 && images.length > 0) {
        ui.currentImageIndex = 0;
      }
      let msg = `${loaded} images loaded`;
      const parts: string[] = [];
      if (dupRemoved > 0) parts.push(`${dupRemoved} duplicates skipped`);
      if (filteredOut > 0) parts.push(`${filteredOut} non-image files`);
      if (failed > 0) parts.push(`${failed} failed to load`);
      if (parts.length > 0) msg += ` (${parts.join(', ')})`;
      showToast(msg, failed > 0 ? 'error' : 'success');
      
      if (failedNames.length > 0) {
        console.warn('Failed to load images:', failedNames);
      }
      
      if (restoredNames.length > 0) {
        setTimeout(() => {
          const labelType = ui.workMode === 'classification' ? '标签' : '标注';
        showToast(`已恢复 ${restoredNames.length} 张图片的历史${labelType}`, 'info');
        }, 800);
      }
    });
  }

  async function handleImportFolder() {
    // 先尝试 Tauri 原生对话框
    const dirPath = await tauriInvoke('pick_directory');
    if (dirPath) {
      try {
        showToast('正在加载图片...', 'info');
        const imgs = await tauriInvoke('read_images_from_dir', { dirPath });
        if (imgs && imgs.length > 0) {
          const files = imgs.map((img: any) => {
            const blob = dataURLtoBlob(img.base64);
            return new File([blob], img.name, { type: blob.type });
          });
          loadImages(files);
          showToast(`成功加载 ${files.length} 张图片`, 'success');
        } else {
          showToast('文件夹中没有找到图片', 'info');
        }
      } catch (e) {
        console.error('Import folder error:', e);
        showToast('导入文件夹失败', 'error');
      }
      return;
    }
    // 浏览器回退
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.addEventListener('change', (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files) loadImages(files);
    });
    input.click();
  }

  function dataURLtoBlob(dataurl: string): Blob {
    const arr = dataurl.split(',');
    const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/png';
    const bstr = atob(arr[1]);
    const u8arr = new Uint8Array(bstr.length);
    for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
    return new Blob([u8arr], { type: mime });
  }

  async function handleImportFiles() {
    // 先尝试 Tauri 原生对话框
    const filePaths = await tauriInvoke('pick_images');
    if (filePaths && filePaths.length > 0) {
      try {
        showToast('正在加载图片...', 'info');
        const files: File[] = [];
        for (const p of filePaths) {
          try {
            const img = await tauriInvoke('read_image_file', { filePath: p });
            if (img) {
              const blob = dataURLtoBlob(img.base64);
              files.push(new File([blob], img.name, { type: blob.type }));
            }
          } catch (e) {
            console.warn('Failed to load:', p, e);
          }
        }
        if (files.length > 0) {
          loadImages(files);
          showToast(`成功加载 ${files.length} 张图片`, 'success');
        }
      } catch (e) {
        console.error('Import files error:', e);
        showToast('导入图片失败', 'error');
      }
      return;
    }
    // 浏览器回退
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,.jpg,.jpeg,.png,.bmp,.webp,.gif,.svg,.avif,.tiff,.tif';
    input.addEventListener('change', (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files) loadImages(files);
    });
    input.click();
  }

  function handleSelectImage(index: number) {
    if (ui.currentImageIndex === index) return;
    saveAnnotations();
    ui.currentImageIndex = index;
    clearSamCache();
  }

  function handleDeleteImage(index: number) {
    if (index < 0 || index >= images.length) return;
    const img = images[index];
    // 释放 objectURL
    try { URL.revokeObjectURL(img.dataUrl); } catch {}
    // 删除标注
    delete annotations[img.name];
    // 从数组删除
    images.splice(index, 1);
    // 处理当前图片索引
    if (ui.currentImageIndex === index) {
      if (images.length > 0) {
        ui.currentImageIndex = Math.min(index, images.length - 1);
      } else {
        ui.currentImageIndex = -1;
      }
    } else if (ui.currentImageIndex > index) {
      ui.currentImageIndex--;
    }
    showToast(`已删除: ${img.name}`, 'info');
    saveAnnotations();
  }

  function jumpToImage(imageName: string) {
    const idx = images.findIndex(img => img.name === imageName);
    if (idx >= 0) {
      handleSelectImage(idx);
      showQualityCheck = false;
    }
  }

  // Drag and drop
  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer?.files) loadImages(e.dataTransfer.files);
  }

  // ============================================================
  // Export
  // ============================================================
  async function handleExportCurrent() {
    const imgData = images[ui.currentImageIndex];
    if (!imgData) return;
    const name = imgData.name;

    // 分类标签 CSV 导出
    if (ui.exportFormat === 'classification_csv') {
      const dirPath = await tauriInvoke('pick_save_directory');
      if (dirPath) {
        const csvContent = getClassificationCSVContent();
        await tauriInvoke('save_file_base64', {
          dirPath,
          filename: 'classification_labels.csv',
          contentBase64: btoa(csvContent),
        });
        showToast(`导出成功！文件已保存到: ${dirPath}`, 'success');
        return;
      }
      exportClassificationCSV();
      showToast('导出成功', 'success');
      return;
    }

    // 尝试 Tauri 原生保存对话框
    {
      const dirPath = await tauriInvoke('pick_save_directory');
      if (dirPath) {

        if (ui.exportFormat === 'png' || ui.exportFormat === 'jpg') {
          const anns = annotations[name] || [];
          const result = await exportVisualImageDataUrl(imgData, anns, { format: ui.exportFormat });
          const base64 = result.dataUrl.split(',')[1];
          await tauriInvoke('save_file_base64', {
            dirPath,
            filename: result.filename,
            contentBase64: base64,
          });
        } else {
          const data = getExportData(name, ui.exportFormat);
          if (!data) { showToast(t('noAnnotations'), 'error'); return; }
          await tauriInvoke('save_file_base64', {
            dirPath,
            filename: data.filename,
            contentBase64: btoa(data.content),
          });
        }
        showToast(`导出成功！文件已保存到: ${dirPath}`, 'success');
        return;
      }
    }

    // PNG/JPG 可视化图片导出（浏览器环境）
    if (ui.exportFormat === 'png' || ui.exportFormat === 'jpg') {
      const anns = annotations[name] || [];
      const result = await exportVisualImageDataUrl(imgData, anns, { format: ui.exportFormat });
      downloadFile(result.filename, result.dataUrl, ui.exportFormat === 'jpg' ? 'image/jpeg' : 'image/png');
      showToast(t('exportSuccess'), 'success');
      return;
    }

    // U-Net Mask 导出
    if (ui.exportFormat === 'unet_mask') {
      const anns = annotations[name] || [];
      const result = await exportUnetMask(imgData, anns);
      downloadFile(result.filename, result.dataUrl, 'image/png');
      showToast(t('exportSuccess'), 'success');
      return;
    }

    const data = getExportData(name, ui.exportFormat);
    if (!data) { showToast(t('noAnnotations'), 'error'); return; }
    downloadFile(data.filename, data.content, data.mimeType);
    showToast(t('exportSuccess'), 'success');
  }

  async function handleImportLabelme(file: File) {
    if (ui.currentImageIndex < 0) {
      showToast('请先选择图片', 'error');
      return;
    }
    try {
      const text = await file.text();
      const imgData = images[ui.currentImageIndex];
      const name = imgData.name;
      // 获取当前最大标注 ID 作为起始 ID
      const existingAnns = annotations[name] || [];
      const maxId = existingAnns.length > 0 ? Math.max(...existingAnns.map(a => a.id)) : -1;
      const imported = parseLabelMe(text, maxId + 1);
      if (imported.length === 0) {
        showToast('文件中没有可导入的标注', 'error');
        return;
      }
      // 自动添加新类别
      for (const ann of imported) {
        if (!classes.includes(ann.className)) {
          classes.push(ann.className);
        }
      }
      if (!annotations[name]) annotations[name] = [];
      annotations[name].push(...imported);
      pushHistory();
      saveAnnotations();
      canvasRef?.render();
      showToast(`已导入 ${imported.length} 个标注`, 'success');
    } catch (e) {
      showToast('导入失败：' + (e as Error).message, 'error');
    }
  }

  async function handleBatchExport() {
    // 分类模式下导出 CSV
    if (ui.workMode === 'classification') {
      const dirPath = await tauriInvoke('pick_save_directory');
      if (dirPath) {
        const csvContent = getClassificationCSVContent();
        await tauriInvoke('save_file_base64', {
          dirPath,
          filename: 'classification_labels.csv',
          contentBase64: btoa(csvContent),
        });
        showToast(`导出成功！文件已保存到: ${dirPath}`, 'success');
        return;
      }
      exportClassificationCSV();
      showToast('导出成功', 'success');
      return;
    }

    if (getImagesWithAnnotations().length === 0) {
      showToast(t('noImagesToExport'), 'error');
      return;
    }

    // 尝试 Tauri 原生对话框
    const dirPath = await tauriInvoke('pick_save_directory');
    if (dirPath) {
      let count = 0;
      const dir = dirPath as string;

      if (ui.exportFormat === 'coco_merged') {
        const content = getMergedCOCO();
        await tauriInvoke('save_file_base64', {
          dirPath: dir,
          filename: 'annotations.json',
          contentBase64: btoa(content),
        });
        count = getImagesWithAnnotations().length;
      } else if (ui.exportFormat === 'png' || ui.exportFormat === 'jpg') {
        const annotatedImgs = getImagesWithAnnotations();
        for (const img of annotatedImgs) {
          const anns = annotations[img.name] || [];
          const result = await exportVisualImageDataUrl(img, anns, { format: ui.exportFormat });
          const base64 = result.dataUrl.split(',')[1];
          await tauriInvoke('save_file_base64', {
            dirPath: dir,
            filename: result.filename,
            contentBase64: base64,
          });
          count++;
        }
      } else {
        for (const img of getImagesWithAnnotations()) {
          const data = getExportData(img.name, ui.exportFormat);
          if (!data) continue;
          await tauriInvoke('save_file_base64', {
            dirPath: dir,
            filename: data.filename,
            contentBase64: btoa(data.content),
          });
          count++;
        }
        if (ui.exportFormat === 'yolo') {
          await tauriInvoke('save_file_base64', {
            dirPath: dir,
            filename: 'classes.txt',
            contentBase64: btoa(classes.join('\n')),
          });
        }
      }

      showToast(`导出成功！${count} 个文件已保存到: ${dir}`, 'success');
      return;
    }

    // 浏览器环境下的原有逻辑
    if (ui.exportFormat === 'coco_merged') {
      const content = getMergedCOCO();
      downloadFile('annotations.json', content, 'application/json');
      showToast(`${t('exportComplete')}: ${getImagesWithAnnotations().length} ${t('totalImages')}`, 'success');
      return;
    }

    // PNG/JPG 可视化 / U-Net Mask 批量导出
    if (ui.exportFormat === 'png' || ui.exportFormat === 'jpg' || ui.exportFormat === 'unet_mask') {
      const annotatedImgs = getImagesWithAnnotations();
      if (annotatedImgs.length === 0) {
        showToast(t('noImagesToExport'), 'error');
        return;
      }
      const mimeType = ui.exportFormat === 'jpg' ? 'image/jpeg' : 'image/png';
      if (window.showDirectoryPicker) {
        try {
          const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
          let count = 0;
          for (const img of annotatedImgs) {
            const anns = annotations[img.name] || [];
            const result = ui.exportFormat === 'unet_mask' ? await exportUnetMask(img, anns) : await exportVisualImageDataUrl(img, anns, { format: ui.exportFormat });
            try {
              const fileHandle = await dirHandle.getFileHandle(result.filename, { create: true });
              const writable = await fileHandle.createWritable();
              // dataUrl 转 blob
              const base64 = result.dataUrl.split(',')[1];
              const binary = atob(base64);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              await writable.write(new Blob([bytes], { type: mimeType }));
              await writable.close();
              count++;
            } catch {}
          }
          showToast(`${t('exportComplete')}: ${count} ${t('exportedFiles')}`, 'success');
          return;
        } catch (e: any) {
          if (e.name === 'AbortError') return;
        }
      }
      // Fallback: 逐个下载
      showToast(t('folderNotSupported'), 'info');
      let delay = 0;
      for (const img of annotatedImgs) {
        const anns = annotations[img.name] || [];
        const result = ui.exportFormat === 'unet_mask' ? await exportUnetMask(img, anns) : await exportVisualImageDataUrl(img, anns, { format: ui.exportFormat });
        setTimeout(() => downloadFile(result.filename, result.dataUrl, mimeType), delay);
        delay += 300;
      }
      setTimeout(() => {
        showToast(`${t('exportComplete')}: ${annotatedImgs.length} ${t('exportedFiles')}`, 'success');
      }, delay + 100);
      return;
    }

    // Try File System Access API
    if (window.showDirectoryPicker) {
      try {
        const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        let count = 0;
        for (const img of getImagesWithAnnotations()) {
          const data = getExportData(img.name, ui.exportFormat);
          if (!data) continue;
          try {
            const fileHandle = await dirHandle.getFileHandle(data.filename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(data.content);
            await writable.close();
            count++;
          } catch {}
        }
        if (ui.exportFormat === 'yolo') {
          try {
            const cf = await dirHandle.getFileHandle('classes.txt', { create: true });
            const cw = await cf.createWritable();
            await cw.write(classes.join('\n'));
            await cw.close();
          } catch {}
        }
        showToast(`${t('exportComplete')}: ${count} ${t('exportedFiles')}`, 'success');
        return;
      } catch (e: any) {
        if (e.name !== 'AbortError') {
          // Fall through to download
        } else return;
      }
    }

    // Fallback
    showToast(t('folderNotSupported'), 'info');
    let delay = 0;
    for (const img of getImagesWithAnnotations()) {
      const data = getExportData(img.name, ui.exportFormat);
      if (!data) continue;
      setTimeout(() => downloadFile(data.filename, data.content, data.mimeType), delay);
      delay += 300;
    }
    if (ui.exportFormat === 'yolo') {
      setTimeout(() => downloadFile('classes.txt', classes.join('\n'), 'text/plain'), delay);
    }
    setTimeout(() => {
      showToast(`${t('exportComplete')}: ${getImagesWithAnnotations().length} ${t('exportedFiles')}`, 'success');
    }, delay + 100);
  }

  function handleImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.xml,.txt';
    input.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      const name = images[ui.currentImageIndex]?.name;
      if (!name) return;
      try {
        // Basic import parsing
        if (file.name.endsWith('.json')) {
          const data = JSON.parse(text);
          if (data.annotations || data.images) {
            // COCO
            const catMap: Record<number, string> = {};
            (data.categories || []).forEach((c: any) => { catMap[c.id] = c.name; });
            const anns: any[] = [];
            (data.annotations || []).forEach((a: any) => {
              const className = catMap[a.category_id] || 'object';
              if (!classes.includes(className)) classes.push(className);
              if (a.bbox && typeof a.angle === 'number') {
                anns.push({ type: 'rotated', cx: a.bbox[0] + a.bbox[2] / 2, cy: a.bbox[1] + a.bbox[3] / 2, w: a.bbox[2], h: a.bbox[3], angle: a.angle, className, id: anns.length });
              } else if (a.bbox) {
                anns.push({ type: 'rect', x: a.bbox[0], y: a.bbox[1], w: a.bbox[2], h: a.bbox[3], className, id: anns.length });
              } else if (a.segmentation?.[0]) {
                const seg = a.segmentation[0];
                const pts = [];
                for (let i = 0; i < seg.length; i += 2) pts.push({ x: seg[i], y: seg[i + 1] });
                anns.push({ type: 'polygon', points: pts, className, id: anns.length });
              } else if (a.keypoints) {
                const pts = [];
                for (let i = 0; i < a.keypoints.length; i += 3) pts.push({ x: a.keypoints[i], y: a.keypoints[i + 1] });
                anns.push({ type: 'keypoint', points: pts, className, id: anns.length });
              }
            });
            annotations[name] = anns;
          }
        } else if (file.name.endsWith('.xml')) {
          // VOC XML
          const parser = new DOMParser();
          const doc = parser.parseFromString(text, 'text/xml');
          const objects = doc.querySelectorAll('object');
          const anns: any[] = [];
          objects.forEach(obj => {
            const cname = obj.querySelector('name')?.textContent || 'object';
            if (!classes.includes(cname)) classes.push(cname);
            const bb = obj.querySelector('bndbox');
            if (bb) {
              const xmin = parseFloat(bb.querySelector('xmin')?.textContent || '0');
              const ymin = parseFloat(bb.querySelector('ymin')?.textContent || '0');
              const xmax = parseFloat(bb.querySelector('xmax')?.textContent || '0');
              const ymax = parseFloat(bb.querySelector('ymax')?.textContent || '0');
              anns.push({ type: 'rect', x: xmin, y: ymin, w: xmax - xmin, h: ymax - ymin, className: cname, id: anns.length });
            }
            const rb = obj.querySelector('rotated_box');
            if (rb) {
              const cx = parseFloat(rb.querySelector('cx')?.textContent || '0');
              const cy = parseFloat(rb.querySelector('cy')?.textContent || '0');
              const w = parseFloat(rb.querySelector('w')?.textContent || '0');
              const h = parseFloat(rb.querySelector('h')?.textContent || '0');
              const angle = parseFloat(rb.querySelector('angle')?.textContent || '0');
              anns.push({ type: 'rotated', cx, cy, w, h, angle, className: cname, id: anns.length });
            }
          });
          annotations[name] = anns;
        } else if (file.name.endsWith('.txt')) {
          // YOLO TXT
          const imgData = images[ui.currentImageIndex];
          const lines = text.trim().split('\n');
          const anns: any[] = [];
          lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            const classIdx = parseInt(parts[0]);
            const className = classes[classIdx] || 'object';
            if (parts.length === 5) {
              const cx = parseFloat(parts[1]) * imgData.width;
              const cy = parseFloat(parts[2]) * imgData.height;
              const w = parseFloat(parts[3]) * imgData.width;
              const h = parseFloat(parts[4]) * imgData.height;
              anns.push({ type: 'rect', x: cx - w / 2, y: cy - h / 2, w, h, className, id: anns.length });
            } else if (parts.length === 9) {
              // OBB rotated box: class x1 y1 x2 y2 x3 y3 x4 y4
              const pts = [];
              for (let i = 1; i < 9; i += 2) {
                pts.push({ x: parseFloat(parts[i]) * imgData.width, y: parseFloat(parts[i + 1]) * imgData.height });
              }
              const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
              const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
              const w = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
              const h = Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y);
              const angle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * 180 / Math.PI;
              anns.push({ type: 'rotated', cx, cy, w, h, angle, className, id: anns.length });
            } else if (parts.length > 5) {
              const pts = [];
              for (let i = 1; i < parts.length; i += 2) {
                pts.push({ x: parseFloat(parts[i]) * imgData.width, y: parseFloat(parts[i + 1]) * imgData.height });
              }
              anns.push({ type: 'polygon', points: pts, className, id: anns.length });
            }
          });
          annotations[name] = anns;
        }
        pushHistory();
        render();
        showToast(t('importSuccess'), 'success');
      } catch (err: any) {
        showToast(t('importFailed') + ': ' + err.message, 'error');
      }
    });
    input.click();
  }

  // ============================================================
  // Project File
  // ============================================================
  function handleSaveProject() {
    saveProjectAs();
  }

  function handleOpenProject() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.annotator,.json';
    input.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) await loadProjectFromFile(file);
    });
    input.click();
  }

  // ============================================================
  // Class management
  // ============================================================
  function handleAddClass(name: string) {
    if (classes.includes(name)) {
      showToast(t('classExists'), 'error');
      return;
    }
    classes.push(name);
    colors[name] = COLORS[classes.length % COLORS.length];
    saveAnnotations();
    showToast(t('classAdded'), 'success');
  }

  function handleChangeClass(id: number, newClass: string) {
    const name = images[ui.currentImageIndex]?.name;
    if (!name) return;
    const ann = (annotations[name] || []).find(a => a.id === id);
    if (ann) {
      ann.className = newClass;
      pushHistory();
      render();
      saveAnnotations();
    }
  }

  function handleSelectClassColor(className: string) {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = getClassColor(className);
    input.addEventListener('change', () => {
      colors[className] = input.value;
      render();
      saveAnnotations();
    });
    input.click();
  }

  // ============================================================
  // Lang
  // ============================================================
  function handleToggleLang() {
    setLang(getLang() === 'zh' ? 'en' : 'zh');
  }
</script>

<svelte:window ondrop={handleDrop} ondragover={handleDragOver} />

<div class="app">
  {#if !sidebarCollapsed}
    <Sidebar
      onSelectImage={handleSelectImage}
      onImportFolder={handleImportFolder}
      onImportFiles={handleImportFiles}
      onDeleteImage={handleDeleteImage}
    />
  {/if}

  <div class="main-area">
    <Toolbar
      onToggleSidebar={() => sidebarCollapsed = !sidebarCollapsed}
      onToggleProps={() => propsCollapsed = !propsCollapsed}
      onUndo={() => canvasRef?.undo()}
      onRedo={() => canvasRef?.redo()}
      onDelete={() => canvasRef?.deleteSelected()}
      onCopy={() => canvasRef?.copySelected()}
      onExport={handleBatchExport}
      onImport={handleImport}
      onSaveProject={handleSaveProject}
      onOpenProject={handleOpenProject}
      onDatasetSplit={() => { closeAllModals(); showDatasetSplit = true; }}
      onQualityCheck={() => { closeAllModals(); showQualityCheck = true; }}
      onYoloAnnotation={() => { closeAllModals(); showYoloModal = true; }}
      onSamAnnotation={() => { closeAllModals(); showSamModal = true; }}
      onStatistics={() => { closeAllModals(); showStatistics = true; }}
      onImageQuality={() => { closeAllModals(); showImageQuality = true; }}
      onBatchOps={() => { closeAllModals(); showBatchOps = true; }}
      onSettings={() => { closeAllModals(); showSettings = true; }}
      onToggleLang={handleToggleLang}
      onToggleTheme={toggleTheme}
      onZoomIn={() => { ui.zoom = Math.min(10, ui.zoom * 1.2); render(); }}
      onZoomOut={() => { ui.zoom = Math.max(0.1, ui.zoom / 1.2); render(); }}
      onFit={() => { fitToScreen(); render(); }}
      imageInfo={imageInfo}
    />

    <Canvas bind:this={canvasRef} />

    <StatusBar bind:this={statusBarRef} />
  </div>

  {#if !propsCollapsed}
    <PropertiesPanel
      onExportCurrent={handleExportCurrent}
      onBatchExport={handleBatchExport}
      onImportLabelme={handleImportLabelme}
      onAddClass={handleAddClass}
      onChangeClass={handleChangeClass}
      onSelectClassColor={handleSelectClassColor}
      onClose={() => propsCollapsed = true}
    />
  {/if}

  <!-- 加载进度条 -->
  {#if ui.isLoading}
    <div class="loading-bar">
      <div class="loading-bar-text">正在加载图片 {ui.loadingCurrent}/{ui.loadingTotal} ({ui.loadingProgress}%)</div>
      <div class="loading-bar-track">
        <div class="loading-bar-fill" style="width:{ui.loadingProgress}%"></div>
      </div>
    </div>
  {/if}

  <!-- 工作模式选择 -->
  {#if ui.showModeSelect}
    <div class="mode-select-overlay">
      <div class="mode-select-content">
        <h2>Annotator Pro</h2>
        <p class="mode-select-desc">选择你要进行的标注任务</p>
        <div class="mode-cards">
          <button class="mode-card" onclick={() => selectMode('detection')}>
            <div class="mode-icon">▭</div>
            <h3>目标检测</h3>
            <p>矩形框、多边形、旋转框</p>
          </button>
          <button class="mode-card" onclick={() => selectMode('classification')}>
            <div class="mode-icon">🏷</div>
            <h3>图像分类</h3>
            <p>整张图片打类别标签</p>
          </button>
          <button class="mode-card disabled" onclick={() => showToast('语义分割即将推出', 'info')}>
            <div class="mode-icon">🎨</div>
            <h3>语义分割</h3>
            <p>像素级掩码标注（即将推出）</p>
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

{#if showSettings}
  <SettingsModal onClose={() => showSettings = false} />
{/if}
{#if showDatasetSplit}
  <DatasetSplitModal onClose={() => showDatasetSplit = false} />
{/if}
{#if showQualityCheck}
  <QualityCheckModal onClose={() => showQualityCheck = false} onJumpToImage={jumpToImage} />
{/if}
{#if showYoloModal}
  <YoloAnnotationModal onClose={() => showYoloModal = false} />
{/if}
{#if showSamModal}
  <SamModelModal onClose={() => showSamModal = false} />
{/if}
{#if showStatistics}
  <StatisticsModal onClose={() => showStatistics = false} />
{/if}
{#if showImageQuality}
  <ImageQualityModal onClose={() => showImageQuality = false} onJumpToImage={jumpToImage} />
{/if}
{#if showBatchOps}
  <BatchOperationsModal onClose={() => showBatchOps = false} onRefresh={() => { if (ui.workMode !== 'classification') canvasRef?.render(); }} />
{/if}

<Toast />

<style>
  .app {
    display: flex; height: 100vh; overflow: hidden;
  }
  .main-area {
    flex: 1; display: flex; flex-direction: column; min-width: 0;
  }
  .loading-bar {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    background: var(--bg-secondary); border: 1px solid var(--border);
    border-radius: var(--radius-lg); padding: 24px 32px;
    box-shadow: var(--shadow-lg); z-index: 1000;
    min-width: 360px;
  }
  .loading-bar-text {
    font-size: var(--text-sm); color: var(--text-primary);
    margin-bottom: 8px; text-align: center;
  }
  .loading-bar-track {
    width: 100%; height: 6px;
    background: var(--bg-tertiary);
    border-radius: 3px; overflow: hidden;
  }
  .loading-bar-fill {
    height: 100%; background: var(--accent-blue);
    border-radius: 3px; transition: width 0.3s ease;
  }
  .mode-select-overlay {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.85);
    display: flex; align-items: center; justify-content: center;
    z-index: 2000;
    backdrop-filter: blur(8px);
  }
  .mode-select-content {
    text-align: center;
  }
  .mode-select-content h2 {
    font-size: 32px;
    font-weight: 700;
    margin-bottom: 8px;
    color: var(--text-primary);
  }
  .mode-select-desc {
    color: var(--text-muted);
    margin-bottom: 40px;
    font-size: 16px;
  }
  .mode-cards {
    display: grid; grid-template-columns: repeat(3, 1fr);
    gap: 24px;
  }
  .mode-card {
    padding: 32px 24px;
    background: var(--bg-secondary);
    border: 2px solid var(--border);
    border-radius: 16px;
    cursor: pointer;
    transition: all 0.2s ease;
    text-align: center;
    color: var(--text-primary);
    font-family: inherit;
  }
  .mode-card:hover {
    border-color: var(--accent-blue);
    transform: translateY(-4px);
    box-shadow: 0 8px 24px rgba(88,166,255,0.2);
  }
  .mode-card.disabled {
    opacity: 0.4; cursor: not-allowed;
  }
  .mode-card.disabled:hover {
    border-color: var(--border);
    transform: none;
    box-shadow: none;
  }
  .mode-icon {
    font-size: 40px;
    margin-bottom: 16px;
  }
  .mode-card h3 {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .mode-card p {
    font-size: 14px;
    color: var(--text-muted);
  }
</style>

































