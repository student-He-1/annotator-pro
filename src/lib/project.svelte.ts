/** 工程文件管理 */
import type { ProjectFile, ProjectImage, ImageInfo, ExportFormat } from './types';
import {
  images, annotations, classes, classColors, ui, selectAnnotation, showToast,
} from './state.svelte';
import { render, fitToScreen } from './canvas/engine.svelte';
import {
  getAllSkeletons, BUILTIN_SKELETONS, mergeCustomSkeletons, type SkeletonTemplate,
} from './skeletons';
import {
  serializeMasks, hasAnyMask, loadMasksFromProject, serializeSegSettings, loadSegSettings, markMasksSaved,
} from './segmentation/store.svelte';

const PROJECT_VERSION = '1.0';
const RECENT_KEY = 'annotator_recent_projects';
const MAX_RECENT = 10;

export interface RecentProject {
  path: string;
  name: string;
  openedAt: number;
}

// ============================================================
// Save Project
// ============================================================

export function buildProjectFile(name: string): ProjectFile {
  const now = new Date().toISOString();
  const projectImages: ProjectImage[] = images.map(img => ({
    name: img.name,
    path: (img as any).path || '',
    width: img.width,
    height: img.height,
  }));

  // 关键点标注引用到的自定义骨架模板随工程走：换机器打开时本机没有这些模板，
  // 只能退回「按点数猜」，连线和导出名都会变样。只写实际引用到、且非内置的模板。
  const builtinIds = new Set(BUILTIN_SKELETONS.map(s => s.id));
  const referenced = new Set<string>();
  for (const list of Object.values(annotations)) {
    for (const ann of list) {
      if (ann.type === 'keypoint' && ann.skeletonId && ann.skeletonId !== 'none') {
        referenced.add(ann.skeletonId);
      }
    }
  }
  const allSkeletons = getAllSkeletons();
  const bundledSkeletons: SkeletonTemplate[] = [...referenced]
    .filter(id => !builtinIds.has(id))
    .map(id => allSkeletons.find(s => s.id === id))
    .filter((t): t is SkeletonTemplate => !!t)
    .map(t => JSON.parse(JSON.stringify(t)));

  const withSeg = ui.workMode === 'segmentation' || hasAnyMask();
  return {
    version: PROJECT_VERSION,
    name,
    createdAt: now,
    updatedAt: now,
    images: projectImages,
    annotations: JSON.parse(JSON.stringify(annotations)),
    imageLabels: JSON.parse(JSON.stringify(ui.imageLabels)),
    // 掩膜字段是**可选**的：检测/分类工程里没有掩膜时干脆不写，
    // 保证旧工程的内容结构与以前完全一致（铁律 A：旧数据零改动）。
    masks: withSeg && hasAnyMask() ? serializeMasks() : undefined,
    classes: [...classes],
    classColors: { ...classColors },
    settings: {
      exportFormat: ui.exportFormat as ExportFormat,
      skeletonId: ui.skeletonId,
      workMode: ui.workMode,
      segmentation: withSeg ? serializeSegSettings() : undefined,
      skeletons: bundledSkeletons.length > 0 ? bundledSkeletons : undefined,
    },
  };
}

/** 文本 → base64（UTF-8 安全）。
 *  btoa 只接受 Latin-1，工程里一旦有中文类名/文件名就会抛 InvalidCharacterError。 */
function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 默认工程文件名，如 annotator-20261020-1055.annotator */
function suggestProjectFileName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `annotator-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.annotator`;
}

export async function saveProjectAs() {
  if (images.length === 0) {
    showToast('没有可保存的图片', 'error');
    return;
  }
  const project = buildProjectFile('untitled');
  const content = JSON.stringify(project, null, 2);
  const filename = suggestProjectFileName();

  // 桌面端：走原生「选择文件夹」+ 原生写盘，并把完整路径明确提示出来。
  // 原来直接 downloadBlob —— 在 Tauri 里文件会悄悄落到默认下载目录，
  // 用户只看到一句「Project saved」，根本不知道存到哪去了。
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const dirPath = await invoke<string | null>('pick_save_directory');
    if (dirPath) {
      const savedPath = await invoke<string>('save_file_base64', {
        dirPath,
        filename,
        contentBase64: utf8ToBase64(content),
      });
      if (savedPath) markMasksSaved();
      showToast(`工程已保存：${savedPath}`, 'success');
      addToRecent(savedPath, filename);
      return;
    }
    // 用户在原生对话框里点了取消：不要退化成浏览器下载，直接结束
    return;
  } catch {
    // 非 Tauri 环境（或原生写盘失败）→ 落回浏览器下载
  }

  downloadBlob(filename, content, 'application/json');
  showToast(`工程已保存：${filename}（浏览器下载目录）`, 'success');
}

// ============================================================
// Load Project
// ============================================================

export async function loadProjectFromFile(file: File): Promise<boolean> {
  try {
    const text = await file.text();
    const project = JSON.parse(text) as ProjectFile;

    if (!project.version || !project.images) {
      showToast('Invalid project file', 'error');
      return false;
    }

    // Restore settings
    if (project.settings) {
      if (project.settings.exportFormat) ui.exportFormat = project.settings.exportFormat;
      if (project.settings.skeletonId) ui.skeletonId = project.settings.skeletonId;
    }

    // Restore classes
    if (project.classes) {
      classes.length = 0;
      classes.push(...project.classes);
    }
    if (project.classColors) {
      Object.keys(classColors).forEach(k => delete classColors[k]);
      Object.assign(classColors, project.classColors);
    }

    // Restore annotations
    Object.keys(annotations).forEach(k => delete annotations[k]);
    Object.assign(annotations, project.annotations || {});

    // 工程可能自带自定义骨架模板定义（换机器打开时本机 localStorage 里没有）。
    // 先合并进本机，再检查缺失 —— 否则刚补进来的模板也会被当成「不存在」。
    let importedSkeletons = 0;
    if (Array.isArray(project.settings?.skeletons) && project.settings.skeletons.length > 0) {
      importedSkeletons = mergeCustomSkeletons(project.settings.skeletons);
    }

    // 关键点标注记着 skeletonId（模板 id）。自定义模板只存在本机 localStorage 里，
    // 换台机器打开同一个工程时可能找不到 —— 那就只能退回「按点数猜」，
    // 连线和导出都会跟着变样。这里明确提示一下，别让它静默降级。
    {
      const known = new Set(getAllSkeletons().map(s => s.id));
      const missing = new Set<string>();
      for (const name of Object.keys(annotations)) {
        for (const ann of annotations[name]) {
          if (ann.type === 'keypoint' && ann.skeletonId && ann.skeletonId !== 'none' && !known.has(ann.skeletonId)) {
            missing.add(ann.skeletonId);
          }
        }
      }
      if (missing.size > 0) {
        showToast(
          `有 ${missing.size} 个骨架模板在本机不存在（${[...missing].slice(0, 3).join(', ')}），` +
          `相关关键点会按点数粗略绘制；请在本机重新创建同名模板`,
          'error'
        );
      } else if (importedSkeletons > 0) {
        showToast(`已从工程导入 ${importedSkeletons} 个自定义骨架模板`, 'success');
      }
    }

    // Restore imageLabels
    Object.keys(ui.imageLabels).forEach(k => delete ui.imageLabels[k]);
    Object.assign(ui.imageLabels, (project as any).imageLabels || {});

    // Restore masks（分割模式）。旧工程没有 masks 字段 → 传 undefined，等同于清空，
    // 免得「打开一个检测工程，上一张图的掩膜还挂在画布上」。这是纯新增命名空间，碰不到 annotations。
    loadMasksFromProject((project as any).masks);
    loadSegSettings((project as any).settings?.segmentation);

    // Restore workMode
    if ((project as any).settings?.workMode) {
      ui.workMode = (project as any).settings.workMode;
      ui.showModeSelect = false;
      if (ui.workMode === 'segmentation' && !String(ui.currentTool).startsWith('seg_')) {
        ui.currentTool = 'seg_select';
      }
    }

    // Load images - try Tauri path first, fallback to file picker
    const tauriAvailable = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

    if (tauriAvailable && project.images.some(img => img.path)) {
      // Load via Tauri backend
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const loadedImages: ImageInfo[] = [];
        const failures: string[] = [];
        for (const pimg of project.images) {
          if (!pimg.path) { failures.push(`${pimg.name}（工程里没记录路径）`); continue; }
          try {
            // Rust 命令参数是 file_path，Tauri 2 要求传 camelCase 的 filePath。
            const entry: any = await invoke('read_image_file', { filePath: pimg.path });
            loadedImages.push({
              // 关键：必须用工程里记录的 name（可能带子目录，如 "jpg/9.jpg"），
              // 不能用 Rust 返回的 entry.name（只是文件名 "9.jpg"）。
              // 标注是以 name 为 key 存的，用错名字就会「图片打开了但一个标注都没有」。
              name: pimg.name,
              dataUrl: entry.base64,
              width: entry.width || pimg.width,
              height: entry.height || pimg.height,
              path: entry.path || pimg.path,
            });
          } catch (e: any) {
            failures.push(`${pimg.name}（${e?.message || e}）`);
          }
        }
        if (loadedImages.length > 0) {
          images.length = 0;
          images.push(...loadedImages);
          // 原来调用的 setCurrentImageIndex() 在项目里根本不存在，
          // 会抛 ReferenceError 把整段加载结果废掉（被外层 catch 吞掉）。
          ui.currentImageIndex = 0;
          selectAnnotation(null);
          setTimeout(() => { fitToScreen(); render(); }, 100);
          addToRecent(file.name, file.name);

          const matched = loadedImages.filter(i => (project.annotations?.[i.name] || []).length > 0).length;
          const totalAnns = Object.values(project.annotations || {}).reduce((s, a) => s + a.length, 0);
          if (failures.length > 0) {
            showToast(`工程已加载 ${loadedImages.length}/${project.images.length} 张，${matched} 张带标注（共 ${totalAnns} 处）；${failures.length} 张读取失败`, 'error');
          } else {
            showToast(`工程已加载：${loadedImages.length} 张图片，${matched} 张带标注（共 ${totalAnns} 处）`, 'success');
          }
          return true;
        }
        if (failures.length > 0) {
          // 全失败时给出具体原因，而不是只说「请重新导入」
          showToast(`工程里的图片都读不到：${failures.slice(0, 2).join('；')}${failures.length > 2 ? ` 等 ${failures.length} 张` : ''}。文件可能已被移动或删除。`, 'error');
          images.length = 0;
          ui.currentImageIndex = -1;
          addToRecent(file.name, file.name);
          return true;
        }
      } catch (e) {
        // Tauri invoke failed, fall through
      }
    }

    // Fallback: no paths or Tauri unavailable, ask user to reselect images
    images.length = 0;
    ui.currentImageIndex = -1;
    showToast(`Project loaded. Please re-import ${project.images.length} image(s) to restore annotations.`, 'info');
    addToRecent(file.name, file.name);
    return true;
  } catch (err: any) {
    showToast('Failed to load project: ' + err.message, 'error');
    return false;
  }
}

// ============================================================
// Recent Projects
// ============================================================

export function getRecentProjects(): RecentProject[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    return [];
  }
}

export function addToRecent(path: string, name: string) {
  const recent = getRecentProjects().filter(p => p.path !== path);
  recent.unshift({ path, name, openedAt: Date.now() });
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
}

export function clearRecentProjects() {
  localStorage.removeItem(RECENT_KEY);
}

// ============================================================
// Helpers
// ============================================================

function downloadBlob(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}


