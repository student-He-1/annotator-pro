<script lang="ts">
  import { onMount } from 'svelte';
  import { t, initLang, getLang, setLang } from '$lib/i18n.svelte';
  import {
    images, ui, classes, classColors, COLORS,
    selectAnnotation, loadSavedData, saveAnnotations, saveAnnotationsNow, showToast,
    applyTheme, toggleTheme,
    getImagesWithAnnotations, getTotalLabelCount,
    classColors as colors, getClassColor, pushHistory,
    annotations, markModified, imageModified, forgetUndoBaseline,
  } from './lib/state.svelte';
  import { getExportData, getMergedCOCO, downloadFile, exportClassificationCSV, getClassificationCSVContent, exportUnetMask, formatDropsKeypoints, formatLabel, getYoloClassNames } from '$lib/export/formats';
  import { exportVisualImageDataUrl } from '$lib/export/visual-export';
  import { getSegExportFiles, getSegBatchFiles } from '$lib/export/segmentation-export';
  import { deleteImageMask } from '$lib/segmentation/store.svelte';
  import { saveProjectAs, loadProjectFromFile } from '$lib/project.svelte';
  import { fitToScreen, render, getMinZoom, clampPan } from '$lib/canvas/engine.svelte';
  import { clearCache as clearSamCache } from '$lib/sam';
  import type { ImageInfo, ExportFormat, Annotation } from '$lib/types';

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

  /** 文本 → base64。
   *  不能用裸 btoa()：它只接受 Latin-1，类别名/文件名一旦含中文就抛
   *  InvalidCharacterError，整个导出会静默失败。这里先转 UTF-8 字节再编码。 */
  function textToBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const CHUNK = 0x8000;   // 分块，避免超长参数导致 apply 爆栈
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  import Toast from './components/Toast.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import Toolbar from './components/Toolbar.svelte';
  import Canvas from './components/Canvas.svelte';
  import PropertiesPanel from './components/PropertiesPanel.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import SettingsModal from './components/SettingsModal.svelte';
  import Splash from './components/Splash.svelte';
  import DatasetSplitModal from './components/DatasetSplitModal.svelte';
  import QualityCheckModal from './components/QualityCheckModal.svelte';
  import YoloAnnotationModal from './components/YoloAnnotationModal.svelte';
  import SamModelModal from './components/SamModelModal.svelte';
  import StatisticsModal from './components/StatisticsModal.svelte';
  import ImageQualityModal from './components/ImageQualityModal.svelte';
  import BatchOperationsModal from './components/BatchOperationsModal.svelte';
  import SegmentationPanel from './components/SegmentationPanel.svelte';
  import { parseLabelMe } from './lib/import/labelme';

  let showSettings = $state(false);
  /** 启动动画：只覆盖界面，不阻塞背后的初始化 */
  let showSplash = $state(true);
  let showDatasetSplit = $state(false);
  let showQualityCheck = $state(false);
  let showYoloModal = $state(false);
  let showSamModal = $state(false);
  let showStatistics = $state(false);
  let showImageQuality = $state(false);
  let showBatchOps = $state(false);
  let sidebarCollapsed = $state(false);
  let propsCollapsed = $state(false);

  // Svelte 5 的组件类型是 `Component`（不是类），`InstanceType<typeof Canvas>` 在类型上
  // 不成立（类型检查里这类报错就是这么来的）。这里只用到下面这些方法，显式写清楚即可。
  interface CanvasApi {
    getImageInfo(): string;
    getWelcomeVisible(): boolean;
    render(): void;
    undo(): void;
    redo(): void;
    deleteSelected(): void;
    copySelected(): void;
  }
  let canvasRef = $state<CanvasApi | null>(null);
  // StatusBar 没有任何导出，类型上只当「有实例」用（没有地方读它的成员）
  let statusBarRef = $state<any>(null);

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
    // 切模式时把当前工具收敛到本模式存在的工具上，否则工具栏一个都不高亮
    if (mode === 'segmentation') {
      if (!String(ui.currentTool).startsWith('seg_')) ui.currentTool = 'seg_select';
    } else if (String(ui.currentTool).startsWith('seg_')) {
      ui.currentTool = 'select';
    }
    // 切模式后立刻重画：分割模式的 overlay 用另一套渲染分支（等于换了一层画布内容）
    render();
  }

  // Init
  // ============================================================
  // 用 onMount 而非 $effect：loadSavedData 会写入 $state，$effect 中写入会触发自身重跑导致死循环（effect_update_depth_exceeded）
  onMount(() => {
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

  /** @param pathMap 可选：相对名 → 磁盘绝对路径。
   *  桌面端导入时把 Rust 返回的真实路径带上，工程文件才能记住图片位置，
   *  否则保存出来的 .annotator 里 path 全是空，下次打开只能让你「重新导入」。 */
  function loadImages(files: FileList | File[], pathMap?: Record<string, string>) {
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
    // 进度条真正接入数据：ui.isLoading / loadingCurrent / loadingTotal / loadingProgress
    // 在 state.svelte.ts 里原本根本不存在，所以模板里的进度条永远不显示（死 UI）。
    ui.isLoading = true;
    ui.loadingTotal = total;
    ui.loadingCurrent = 0;
    ui.loadingProgress = 0;
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
            path: pathMap?.[displayName] || pathMap?.[file.name] || '',
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
        // 进度按「已处理完的张数」算（成功 + 失败都算处理完），
        // 否则有坏图时进度条永远到不了 100%
        const done = loaded + failed;
        ui.loadingCurrent = done;
        ui.loadingProgress = total > 0 ? Math.round(done / total * 100) : 100;
        if (loaded % 5 === 0 || loaded === total) {
          showToast(`Loading ${loaded}/${total} images...`, 'info');
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, newFiles.length) }, () => worker());
    Promise.all(workers).then(() => {
      ui.isLoading = false;
      ui.loadingCurrent = total;
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
    })
      .catch((e: any) => {
        // 兜底：worker 里一旦抛异常就不该让进度遮罩一直挂着
        console.error('loadImages failed:', e);
        showToast('导入过程中出错：' + (e?.message || e), 'error');
      })
      .finally(() => {
        ui.isLoading = false;
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
          // 记住每张图的磁盘绝对路径，否则工程文件里 path 全空 → 下次打开只能重新导入
          const pathMap: Record<string, string> = {};
          for (const img of imgs) { if (img?.path) pathMap[img.name] = img.path; }
          loadImages(files, pathMap);
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
        const pathMap: Record<string, string> = {};
        for (const p of filePaths) {
          try {
            const img = await tauriInvoke('read_image_file', { filePath: p });
            if (img) {
              const blob = dataURLtoBlob(img.base64);
              files.push(new File([blob], img.name, { type: blob.type }));
              pathMap[img.name] = img.path || p;
            }
          } catch (e) {
            console.warn('Failed to load:', p, e);
          }
        }
        if (files.length > 0) {
          loadImages(files, pathMap);
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
    // 分类模式的图片标签也在这个 key 上，不一起删就会把已删除图片的标签留在
    // ui.imageLabels 里：保存工程/导出 CSV 会带上幽灵条目，
    // 以后重新导入同名图片还会「继承」上一次的标签。
    delete ui.imageLabels[img.name];
    // 掩膜也是以 name 为 key：不删就会「幽灵掩膜」，以后重新导入同名图片会继承上一次的分割结果
    deleteImageMask(img.name);
    delete imageModified[img.name];
    // 撤销基线也一起丢掉，否则以后重新导入同名图片时，撤到底会还原成这一轮删掉的旧数据
    forgetUndoBaseline(img.name);
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

  /** 一键清空图片列表。只清列表，标注数据保留 —— 重新导入同名图片还能恢复。 */
  function handleClearImages() {
    if (images.length === 0) { showToast('图片列表已经是空的', 'info'); return; }
    const n = images.length;
    if (!confirm(`确定清空当前 ${n} 张图片吗？\n\n只清空列表，标注数据会保留；重新导入同名图片即可恢复。`)) return;

    for (const img of images) {
      try { URL.revokeObjectURL(img.dataUrl); } catch {}
    }
    images.splice(0, images.length);
    forgetUndoBaseline();   // 重新导入时按新状态重新记录基线
    ui.currentImageIndex = -1;
    ui.currentImage = null;
    ui.imageLoading = false;
    ui.selectedAnnotation = null;
    ui.polygonPoints = [];
    ui.isDrawing = false;
    ui.drawingAnnotation = null;
    render();
    saveAnnotations();
    showToast(`已清空 ${n} 张图片（标注数据已保留）`, 'success');
  }

  function jumpToImage(imageName: string) {
    const idx = images.findIndex(img => img.name === imageName);
    if (idx >= 0) {
      handleSelectImage(idx);
      // 原来只关了「标注质量校验」，而「图片质量筛查」也传了同一个 onJumpToImage，
      // 从那边点跳转后弹窗一直盖在画面上。两个都关掉。
      showQualityCheck = false;
      showImageQuality = false;
    } else {
      showToast(`图片列表里没有 ${imageName}，请先导入它`, 'error');
    }
  }

  // Drag and drop
  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  /** 从 DataTransfer 里收集文件；拖进来的是文件夹就递归展开。
   *  说明：必须在 tauri.conf.json 里把 dragDropEnabled 设为 false，
   *  否则 Tauri 会拦截系统拖放、HTML5 的 drop 事件根本不会触发（表现就是「拖进来没反应」）。 */
  async function collectDroppedFiles(dt: DataTransfer): Promise<File[]> {
    const items = Array.from(dt.items || []);
    const entries = items
      .map(it => (typeof (it as any).webkitGetAsEntry === 'function' ? (it as any).webkitGetAsEntry() : null))
      .filter(Boolean) as any[];

    if (entries.length === 0) return Array.from(dt.files || []);

    const out: File[] = [];
    async function walk(entry: any, prefix: string) {
      if (entry.isFile) {
        const file: File = await new Promise((res, rej) => entry.file(res, rej));
        // 保留相对路径，让「拖文件夹」和「导入文件夹」的命名语义一致
        try { Object.defineProperty(file, 'webkitRelativePath', { value: prefix + file.name }); } catch { /* ignore */ }
        out.push(file);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        // readEntries 每次最多返回 100 条，必须循环读到空
        for (;;) {
          const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (batch.length === 0) break;
          for (const e of batch) await walk(e, prefix + entry.name + '/');
        }
      }
    }
    for (const e of entries) await walk(e, '');
    return out;
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    if (!e.dataTransfer) return;
    try {
      const files = await collectDroppedFiles(e.dataTransfer);
      const imagesOnly = files.filter(isImageFile);
      if (imagesOnly.length === 0) {
        showToast(files.length === 0 ? '没有读到文件' : `拖入的 ${files.length} 个文件里没有图片`, 'error');
        return;
      }
      loadImages(imagesOnly);
    } catch (err: any) {
      showToast('拖拽导入失败: ' + (err?.message || err), 'error');
    }
  }

  // ============================================================
  // Export
  // ============================================================
  /** 分类模式的导出：CSV，一行 = 一张图的一个标签。
   *
   *  两种模式的两个导出入口（属性面板按钮、工具栏 ↓）全部走这里，原因：
   *  1. 原来这段逻辑写了两份，都**没检查 `save_file_base64` 的返回值** ——
   *     写盘失败照样弹「导出成功」，目录里一个文件都没有（都是"没检查返回值"的同一类坑）。
   *  2. 原来还有两条 `ui.exportFormat === 'classification_csv'` 的分支，但
   *     `classification_csv` 根本不在格式下拉的 formats 里、分类模式下下拉框也不渲染，
   *     所以那两条永远走不到，是死代码。
   */
  // 注意：这个本地函数和 `formats.ts` 里那个 `exportClassificationCSV()`（浏览器下载）不是一回事，
  // 名字故意不用大小写区分，避免看花眼。
  async function exportClassificationLabels() {
    const labelCount = getTotalLabelCount();
    if (labelCount === 0) {
      showToast('还没有打过任何标签，没有可导出的内容', 'error');
      return;
    }
    const csvContent = getClassificationCSVContent();
    const filename = 'classification_labels.csv';

    const dirPath = await tauriInvoke('pick_save_directory');
    if (!dirPath) {
      // 浏览器里没有原生目录对话框 → 退回 <a download>；Tauri 里这就是取消
      const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__;
      if (isTauri) { showToast('已取消导出', 'info'); return; }
      exportClassificationCSV();
      showToast(`导出成功：${filename}（${labelCount} 个标签）`, 'success');
      return;
    }

    const savedPath = await tauriInvoke('save_file_base64', {
      dirPath,
      filename,
      contentBase64: textToBase64(csvContent),
    });
    if (savedPath) {
      showToast(`导出成功：${savedPath}（${labelCount} 个标签）`, 'success');
    } else {
      showToast(`导出失败：未能写入 ${dirPath}（请检查目录权限，或换一个目录）`, 'error');
    }
  }

  /** 导出前提醒：VOC / CreateML 没有关键点概念，骨架会被丢掉。
   *  以前是**静默丢弃**的 —— 用户导完发现骨架没了，还以为是没标上。
   *  YOLO 现在走 ultralytics pose 行，不再丢；要保留关键点也可以用 COCO / LabelMe。 */
  function warnIfDropsKeypoints(annsList: Annotation[][]) {
    if (!formatDropsKeypoints(ui.exportFormat)) return;
    const n = annsList.reduce((s, anns) => s + anns.filter(a => a.type === 'keypoint').length, 0);
    if (n > 0) {
      showToast(
        `${formatLabel(ui.exportFormat)} 不支持关键点，${n} 个骨架不会写入文件（要保留请改用 COCO / LabelMe / YOLO）`,
        'error'
      );
    }
  }

  /** 导出前的通用「写一个文件」：单图走原生另存为，批量走文件夹。
   *  两边都必须检查返回值 —— tauriInvoke 吞异常返回 null，不看就会出现
   *  「提示导出成功、目录里一个文件都没有」。
   *  分割模式的导出是 async（PNG 要走 CompressionStream），且可能一个图出多个文件。 */
  function segFileBase64(f: { content?: string; base64?: string }): string {
    return f.base64 ?? textToBase64(f.content || '');
  }

  async function handleSegExportCurrent() {
    const name = images[ui.currentImageIndex]?.name;
    if (!name) { showToast('请先选择一张图片', 'error'); return; }
    // 导出前先强制落盘：YOLO-seg 是重操作，万一渲染进程崩溃，未保存的掩膜不会跟着丢
    if (!saveAnnotationsNow()) {
      showToast('导出前保存失败：请先用「保存工程」落盘再导出', 'error');
      return;
    }
    const format = ui.segExportFormat as any;
    let files: Awaited<ReturnType<typeof getSegExportFiles>> = [];
    try {
      files = await getSegExportFiles(name, format);
    } catch (e: any) {
      showToast('导出失败：' + (e?.message || e), 'error');
      return;
    }
    if (files.length === 0) {
      showToast('这个格式没有可导出的内容（COCO 只写「实例」区域）', 'error');
      return;
    }
    const f = files[0];
    const contentBase64 = segFileBase64(f);
    const savedPath = await tauriInvoke('save_file_as', { defaultName: f.filename, contentBase64 });
    if (savedPath) {
      showToast(`导出成功：${savedPath}`, 'success');
      if (format === 'seg_instances') {
        showToast('逐实例 PNG + 清单请用「批量导出」（单图另存为只能落一个文件）', 'info');
      }
      return;
    }
    const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__;
    if (isTauri) { showToast('已取消导出', 'info'); return; }
    downloadFile(f.filename, `data:${f.mimeType};base64,${contentBase64}`, f.mimeType);
    showToast('导出完成（浏览器下载）', 'success');
  }

  async function handleSegBatchExport() {
    // 同上：批量导出前先把当前掩膜落盘，避免重操作崩溃导致数据丢失
    if (!saveAnnotationsNow()) {
      showToast('导出前保存失败：请先用「保存工程」落盘再导出', 'error');
      return;
    }
    const format = ui.segExportFormat as any;
    let files: Awaited<ReturnType<typeof getSegBatchFiles>> = [];
    try {
      files = await getSegBatchFiles(format);
    } catch (e: any) {
      showToast('导出失败：' + (e?.message || e), 'error');
      return;
    }
    if (files.length === 0) { showToast('还没有可导出的掩膜区域', 'error'); return; }

    const dirPath = await tauriInvoke('pick_save_directory');
    const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__;
    if (!dirPath) {
      if (isTauri) { showToast('已取消导出', 'info'); return; }
      // 浏览器：逐个下载
      let delay = 0;
      for (const f of files) {
        const dataUrl = f.base64 ? `data:${f.mimeType};base64,${f.base64}` : f.content!;
        const mime = f.mimeType;
        setTimeout(() => downloadFile(f.filename, dataUrl, mime), delay);
        delay += 300;
      }
      showToast(`导出完成：${files.length} 个文件`, 'success');
      return;
    }

    let count = 0;
    let failed = 0;
    const used = new Set<string>();
    for (const f of files) {
      let unique = f.filename;
      if (used.has(unique)) {
        const m = f.filename.match(/^(.*?)(\.[^.]+)$/);
        const stem = m ? m[1] : f.filename;
        const ext = m ? m[2] : '';
        let n = 2;
        while (used.has(`${stem}-${n}${ext}`)) n++;
        unique = `${stem}-${n}${ext}`;
      }
      used.add(unique);
      const ok = await tauriInvoke('save_file_base64', {
        dirPath,
        filename: unique,
        contentBase64: segFileBase64(f),
      });
      if (ok) count++; else failed++;
    }
    if (count === 0) showToast(`导出失败：没有任何文件写入 ${dirPath}`, 'error');
    else if (failed > 0) showToast(`导出完成：成功 ${count} 个，失败 ${failed} 个；目录：${dirPath}`, 'error');
    else showToast(`导出成功：${count} 个文件；目录：${dirPath}`, 'success');
  }

  async function handleExportCurrent() {
    // 分割模式：整条导出链路走 segmentation-export（不碰 formats.ts 的旧 case）
    if (ui.workMode === 'segmentation') { await handleSegExportCurrent(); return; }
    // 分类模式没有「单图标注文件」这回事，统一导出标签 CSV
    if (ui.workMode === 'classification') { await exportClassificationLabels(); return; }

    const imgData = images[ui.currentImageIndex];
    if (!imgData) return;
    const name = imgData.name;

    warnIfDropsKeypoints([annotations[name] || []]);

    // 先把要写的内容准备好，再决定怎么落地
    const anns = annotations[name] || [];
    const isImageFmt = ui.exportFormat === 'png' || ui.exportFormat === 'jpg' || ui.exportFormat === 'unet_mask';
    let filename = '';
    let contentBase64 = '';
    let dataUrl = '';
    let mimeType = '';

    if (isImageFmt) {
      // unet_mask 走灰度图导出，和可视化图是两条不同的实现
      const result = ui.exportFormat === 'unet_mask'
        ? await exportUnetMask(imgData, anns)
        : await exportVisualImageDataUrl(imgData, anns, { format: ui.exportFormat as 'png' | 'jpg' });
      filename = result.filename;
      dataUrl = result.dataUrl;
      contentBase64 = result.dataUrl.split(',')[1];
      mimeType = ui.exportFormat === 'jpg' ? 'image/jpeg' : 'image/png';
    } else {
      const data = getExportData(name, ui.exportFormat);
      if (!data) { showToast(t('noAnnotations'), 'error'); return; }
      filename = data.filename;
      mimeType = data.mimeType;
      contentBase64 = textToBase64(data.content);
      dataUrl = `data:${mimeType};base64,${contentBase64}`;
    }

    // 单图导出走「另存为」：不用先选文件夹，也不会因为文件名带相对路径而多建子目录
    const savedPath = await tauriInvoke('save_file_as', { defaultName: filename, contentBase64 });
    if (savedPath) {
      showToast(`导出成功：${savedPath}`, 'success');
      return;
    }
    // 返回 null 有两种可能：浏览器环境没有这个命令 / 用户在对话框里取消了
    const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__;
    if (isTauri) { showToast('已取消导出', 'info'); return; }

    // 浏览器环境：退回下载
    downloadFile(filename, dataUrl, mimeType);
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
    // 分割模式：批量导出掩膜
    if (ui.workMode === 'segmentation') { await handleSegBatchExport(); return; }
    // 分类模式：导出标签 CSV（统一走 exportClassificationLabels，内含写盘校验）
    if (ui.workMode === 'classification') {
      await exportClassificationLabels();
      return;
    }

    if (getImagesWithAnnotations().length === 0) {
      showToast(t('noImagesToExport'), 'error');
      return;
    }

    warnIfDropsKeypoints(getImagesWithAnnotations().map(img => annotations[img.name] || []));

    // 尝试 Tauri 原生对话框
    const dirPath = await tauriInvoke('pick_save_directory');
    if (dirPath) {
      const dir = dirPath as string;
      let count = 0;
      let failed = 0;

      // save_file_base64 失败时 tauriInvoke 会吞掉异常返回 null，
      // 所以必须看返回值 —— 原来写完就 count++，会报「成功」但目录里什么都没有。
      // 另外导出文件名现在只用 basename（不再带 photos/ 这种子目录），
      // 不同子文件夹里的同名图片会撞车，这里加 -2 / -3 后缀避免互相覆盖。
      const usedNames = new Set<string>();
      const writeOne = async (filename: string, contentBase64: string) => {
        let unique = filename;
        if (usedNames.has(unique)) {
          const m = filename.match(/^(.*?)(\.[^.]+)$/);
          const stem = m ? m[1] : filename;
          const ext = m ? m[2] : '';
          let n = 2;
          while (usedNames.has(`${stem}-${n}${ext}`)) n++;
          unique = `${stem}-${n}${ext}`;
        }
        usedNames.add(unique);
        const ok = await tauriInvoke('save_file_base64', { dirPath: dir, filename: unique, contentBase64 });
        if (ok) count++; else failed++;
      };

      if (ui.exportFormat === 'coco_merged') {
        await writeOne('annotations.json', textToBase64(getMergedCOCO()));
      } else if (ui.exportFormat === 'png' || ui.exportFormat === 'jpg' || ui.exportFormat === 'unet_mask') {
        for (const img of getImagesWithAnnotations()) {
          const anns = annotations[img.name] || [];
          const result = ui.exportFormat === 'unet_mask'
            ? await exportUnetMask(img, anns)
            : await exportVisualImageDataUrl(img, anns, { format: ui.exportFormat as 'png' | 'jpg' });
          await writeOne(result.filename, result.dataUrl.split(',')[1]);
        }
      } else {
        for (const img of getImagesWithAnnotations()) {
          const data = getExportData(img.name, ui.exportFormat);
          if (!data) continue;
          await writeOne(data.filename, textToBase64(data.content));
        }
        if (ui.exportFormat === 'yolo') {
          await writeOne('classes.txt', textToBase64(getYoloClassNames().join('\n')));
        }
      }

      const isImageFmt = ui.exportFormat === 'png' || ui.exportFormat === 'jpg' || ui.exportFormat === 'unet_mask';
      const note = isImageFmt ? '' : '（该格式导出的是标注文件，不是图片）';
      if (count === 0) {
        showToast(`导出失败：没有任何文件写入 ${dir}${failed > 0 ? `（${failed} 个失败）` : ''}`, 'error');
      } else if (failed > 0) {
        showToast(`导出完成：成功 ${count} 个，失败 ${failed} 个${note}；目录：${dir}`, 'error');
      } else {
        showToast(`导出成功：${count} 个文件${note}；目录：${dir}`, 'success');
      }
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
            await cw.write(getYoloClassNames().join('\n'));
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
      setTimeout(() => downloadFile('classes.txt', getYoloClassNames().join('\n'), 'text/plain'), delay);
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
  async function handleSaveProject() {
    await saveProjectAs();
  }

  /** 立刻保存标注（工具栏「保存标注」按钮 = Ctrl+S）。
   *  自动保存机制没动，这只是多一个「按了就一定有反馈」的入口。
   *
   *  数量必须统计**当前图片**。原来用的是 getCurrentModeCount() —— 那是**全工程合计**，
   *  于是「把当前图删光 → 点保存」仍然显示「共 13 处标注」，切到别的图也不变，
   *  看起来像没刷新/卡死。这里直接读 annotations[当前图]，不经过任何 derived。 */
  function handleSaveAnnotationsNow() {
    const name = images[ui.currentImageIndex]?.name;
    const isCls = ui.workMode === 'classification';
    const isSeg = ui.workMode === 'segmentation';
    const n = name
      ? (isCls
        ? (ui.imageLabels[name]?.length || 0)
        : isSeg ? (ui.maskCounts?.[name] || 0) : (annotations[name]?.length || 0))
      : 0;
    // saveAnnotationsNow 自己会写分割掩膜（store 注册的钩子），失败时它已经报过错
    if (saveAnnotationsNow()) {
      showToast(`已保存 · 当前图片 ${n} ${isCls ? '个标签' : isSeg ? '个区域' : '处标注'}`, 'success');
    }
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

{#if showSplash}
  <Splash onDone={() => showSplash = false} />
{/if}

<div class="app">
  {#if !sidebarCollapsed}
    <Sidebar
      onSelectImage={handleSelectImage}
      onImportFolder={handleImportFolder}
      onImportFiles={handleImportFiles}
      onDeleteImage={handleDeleteImage}
      onClearImages={handleClearImages}
    />
  {/if}

  <div class="main-area">
    <Toolbar
      onToggleSidebar={() => sidebarCollapsed = !sidebarCollapsed}
      onToggleProps={() => propsCollapsed = !propsCollapsed}
      onUndo={() => canvasRef?.undo()}
      onRedo={() => canvasRef?.redo()}
      onSaveAnnotations={handleSaveAnnotationsNow}
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
      onZoomIn={() => { ui.zoom = Math.min(10, ui.zoom * 1.2); clampPan(); render(); }}
      onZoomOut={() => { ui.zoom = Math.max(getMinZoom(), ui.zoom / 1.2); clampPan(); render(); }}
      onFit={() => { fitToScreen(); render(); }}
      imageInfo={imageInfo}
    />

    <Canvas bind:this={canvasRef} />

    <StatusBar bind:this={statusBarRef} />
  </div>

  {#if !propsCollapsed}
    {#if ui.workMode === 'segmentation'}
      <!-- 分割模式用自己的面板，完全不进 PropertiesPanel（那个文件是检测/分类共用的） -->
      <SegmentationPanel
        onExportCurrent={handleSegExportCurrent}
        onBatchExport={handleSegBatchExport}
        onClose={() => propsCollapsed = true}
      />
    {:else}
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
          <button class="mode-card" onclick={() => selectMode('segmentation')}>
            <div class="mode-icon">▦</div>
            <h3>图像分割</h3>
            <p>像素级掩膜 · SAM3 开放词汇</p>
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
  <BatchOperationsModal onClose={() => showBatchOps = false} onRefresh={() => { if (ui.workMode === 'detection') canvasRef?.render(); }} />
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

































