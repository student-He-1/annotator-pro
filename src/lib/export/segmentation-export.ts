/** 分割模式导出（P1a：先只做 COCO 实例。
 *  另三种（Cityscapes 语义 PNG / 实例掩膜 PNG / U-Net）在 P1b 补齐 —— 见方案 §7。
 *
 *  为什么不写进 `formats.ts`：那个文件是检测/分类模式的导出实现（VOC/YOLO/COCO…），
 *  铁律 A 明确「不动现有导出 case」。分割模式的数据来自 masks，和 annotations 无关，
 *  单独一个文件、单独一组 `seg_*` 格式值，互不干扰。
 */
import { images, ui } from '../state.svelte';
import { getImagesWithMasks, getMaskForExport, getImageMask } from '../segmentation/store.svelte';
import type { ImageMask } from '../segmentation/types';
import { regionStats, rleBinaryColMajor } from '../segmentation/rle';

export interface SegExportFile {
  filename: string;
  content: string;
  mimeType: string;
}

function baseName(name: string): string {
  const file = name.split(/[\\/]/).pop() || name;
  return file.replace(/\.[^.]+$/, '');
}

interface CocoBuildOptions {
  /** 只导出这些图片（缺省 = 所有有掩膜的图片） */
  only?: string[];
  /** 合并成一个文件时，image_id 在整个工程内唯一 */
  merged: boolean;
}

/** 生成 COCO 实例标注 JSON。
 *  只导 `kind === 'instance'` 且未隐藏的区域 —— stuff（road/sky）没有实例身份，
 *  按 COCO 的语义塞进去会被当成「一大片同类目标」，训练时反而污染。 */
function buildCoco(options: CocoBuildOptions): { content: string; imageCount: number; annCount: number } {
  const names = options.only && options.only.length > 0
    ? options.only
    : getImagesWithMasks().map(i => i.name);

  const categories = ui.segClasses.map((name, i) => ({ id: i + 1, name, supercategory: 'none' }));
  const catIdOf = new Map<string, number>();
  categories.forEach(c => catIdOf.set(c.name, c.id));

  const outImages: any[] = [];
  const outAnns: any[] = [];
  let annId = 1;

  for (const name of names) {
    const got = getMaskForExport(name);
    if (!got) continue;
    const { mask, map } = got;
    const imageId = outImages.length + 1;
    const imgData = images.find(i => i.name === name);
    outImages.push({
      id: imageId,
      file_name: imgData?.name || name,
      width: mask.width,
      height: mask.height,
    });

    for (const region of mask.regions) {
      if (region.kind !== 'instance' || region.hidden) continue;
      let catId = catIdOf.get(region.className);
      if (!catId) {
        catId = categories.length + 1;
        categories.push({ id: catId, name: region.className, supercategory: 'none' });
        catIdOf.set(region.className, catId);
      }
      const st = regionStats(map, mask.width, region.ordinal);
      if (st.area === 0 || !st.box) continue;
      const counts = rleBinaryColMajor(map, mask.width, mask.height, region.ordinal);
      outAnns.push({
        id: annId++,
        image_id: imageId,
        category_id: catId,
        segmentation: { counts, size: [mask.height, mask.width] },
        area: st.area,
        bbox: [st.box.x1, st.box.y1, st.box.x2 - st.box.x1, st.box.y2 - st.box.y1],
        iscrowd: 0,
      });
    }
  }

  const payload = {
    info: {
      description: 'Annotator Pro segmentation masks',
      date_created: new Date().toISOString(),
    },
    images: outImages,
    annotations: outAnns,
    categories,
  };
  // 紧凑输出：counts 动辄上千个数字，缩进会把文件体积放大 3~4 倍（方案 §7）
  return { content: JSON.stringify(payload), imageCount: outImages.length, annCount: outAnns.length };
}

/** 单图导出：一张图一个文件 */
export function getSegExportData(imageName: string): SegExportFile | null {
  const got = getMaskForExport(imageName);
  if (!got) return null;
  const { content, annCount } = buildCoco({ only: [imageName], merged: false });
  if (annCount === 0) {
    // 只有 stuff 区域时 COCO 会是空标注 —— 这不是错误，但要明确告诉用户
    return { filename: `${baseName(imageName)}_masks.json`, content, mimeType: 'application/json' };
  }
  return { filename: `${baseName(imageName)}_masks.json`, content, mimeType: 'application/json' };
}

/** 批量导出：seg_coco = 每图一个文件；seg_coco_merged = 合并一个文件 */
export function getSegBatchExportData(merged: boolean): SegExportFile[] {
  const names = getImagesWithMasks().map(i => i.name);
  if (names.length === 0) return [];
  if (merged) {
    const { content } = buildCoco({ merged: true });
    return [{ filename: 'annotations_masks.json', content, mimeType: 'application/json' }];
  }
  const out: SegExportFile[] = [];
  for (const name of names) {
    const f = getSegExportData(name);
    if (f) out.push(f);
  }
  return out;
}

/** P1b 会往里加用法说明；现在只有 COCO 一项，所以面板上只列这一项。 */
export const SEG_EXPORT_FORMATS = [
  { value: 'seg_coco' as const, label: 'COCO 实例 JSON（每图一个）' },
  { value: 'seg_coco_merged' as const, label: 'COCO 实例 JSON（合并一个）' },
];

/** 统计一句话，导出前给用户看。
 *  注意：这里**不解码整图**（面板每次重渲染都会调它，解码 2 MB/张会卡）。
 *  只读 counts+regions 这份紧凑数据。 */
export function describeMasks(): string {
  const entries = getImagesWithMasks();
  let instances = 0;
  let stuff = 0;
  for (const e of entries) {
    const mask = getImageMask(e.name);
    if (!mask) continue;
    for (const r of mask.regions) {
      if (r.hidden) continue;
      if (r.kind === 'instance') instances++; else stuff++;
    }
  }
  return `${entries.length} 张图 · ${instances} 个实例区域 · ${stuff} 个整片(stuff)区域`;
}

/** 给统计弹窗用：按类别统计像素占比（P1a 先只给区域数） */
export function getSegClassRegionCounts(mask: ImageMask): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of mask.regions) {
    if (r.hidden) continue;
    out[r.className] = (out[r.className] || 0) + 1;
  }
  return out;
}
