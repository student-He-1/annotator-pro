/** 工程文件管理 */
import type { ProjectFile, ProjectImage, ImageInfo, ExportFormat } from './types';
import {
  images, annotations, classes, classColors, ui, selectAnnotation, showToast,
} from './state.svelte';
import { render, fitToScreen } from './canvas/engine.svelte';

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

  return {
    version: PROJECT_VERSION,
    name,
    createdAt: now,
    updatedAt: now,
    images: projectImages,
    annotations: JSON.parse(JSON.stringify(annotations)),
    imageLabels: JSON.parse(JSON.stringify(ui.imageLabels)),
    classes: [...classes],
    classColors: { ...classColors },
    settings: {
      exportFormat: ui.exportFormat as ExportFormat,
      skeletonId: ui.skeletonId,
      workMode: ui.workMode,
    },
  };
}

export function saveProjectAs() {
  if (images.length === 0) {
    showToast('No images to save', 'error');
    return;
  }
  const project = buildProjectFile('untitled');
  const content = JSON.stringify(project, null, 2);
  downloadBlob('project.annotator', content, 'application/json');
  showToast('Project saved', 'success');
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

    // Restore imageLabels
    Object.keys(ui.imageLabels).forEach(k => delete ui.imageLabels[k]);
    Object.assign(ui.imageLabels, (project as any).imageLabels || {});

    // Restore workMode
    if ((project as any).settings?.workMode) {
      ui.workMode = (project as any).settings.workMode;
      ui.showModeSelect = false;
    }

    // Load images - try Tauri path first, fallback to file picker
    const tauriAvailable = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

    if (tauriAvailable && project.images.some(img => img.path)) {
      // Load via Tauri backend
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const loadedImages: ImageInfo[] = [];
        for (const pimg of project.images) {
          if (pimg.path) {
            try {
              const entry: any = await invoke('read_image_file', { path: pimg.path });
              loadedImages.push({
                name: entry.name,
                dataUrl: entry.base64,
                width: entry.width || pimg.width,
                height: entry.height || pimg.height,
              });
            } catch {
              // File not found, skip
            }
          }
        }
        if (loadedImages.length > 0) {
          images.length = 0;
          images.push(...loadedImages);
          setCurrentImageIndex(0);
          selectAnnotation(null);
          setTimeout(() => { fitToScreen(); render(); }, 100);
          addToRecent(file.name, file.name);
          showToast(`Project loaded: ${loadedImages.length}/${project.images.length} images`, 'success');
          return true;
        }
      } catch (e) {
        // Tauri invoke failed, fall through
      }
    }

    // Fallback: no paths or Tauri unavailable, ask user to reselect images
    images.length = 0;
    setCurrentImageIndex(-1);
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


