<script lang="ts">
  import { t } from '$lib/i18n.svelte';
  import { images, annotations, classes, classColors, getClassColor, ui } from '$lib/state.svelte';
  import type { Annotation } from '$lib/types';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  // 统计数据
  const stats = $derived.by(() => {
    const totalImages = images.length;
    let annotatedImages = 0;
    let totalAnnotations = 0;
    const classCounts: Record<string, number> = {};
    const typeCounts: Record<string, number> = { rect: 0, polygon: 0, rotated: 0, keypoint: 0 };
    const perImage: { name: string; count: number }[] = [];

    if (ui.workMode === 'classification') {
      // 分类标签统计
      for (const img of images) {
        const labels = ui.imageLabels[img.name] || [];
        perImage.push({ name: img.name, count: labels.length });
        if (labels.length > 0) annotatedImages++;
        totalAnnotations += labels.length;
        for (const label of labels) {
          classCounts[label] = (classCounts[label] || 0) + 1;
        }
      }
    } else {
      // 检测标注统计
      for (const img of images) {
        const anns = annotations[img.name] || [];
        perImage.push({ name: img.name, count: anns.length });
        if (anns.length > 0) annotatedImages++;
        totalAnnotations += anns.length;
        for (const ann of anns) {
          classCounts[ann.className] = (classCounts[ann.className] || 0) + 1;
          if (ann.type in typeCounts) typeCounts[ann.type]++;
        }
      }
    }

    // 类别排序（按数量降序）
    const classSorted = Object.entries(classCounts).sort((a, b) => b[1] - a[1]);
    // 每图标注数排序（降序，取前10）
    const perImageSorted = [...perImage].sort((a, b) => b.count - a.count).slice(0, 10);
    // 最大类别数量（用于柱状图比例）
    const maxClassCount = classSorted.length > 0 ? classSorted[0][1] : 1;
    const maxPerImage = perImageSorted.length > 0 ? perImageSorted[0].count : 1;

    const completionRate = totalImages > 0 ? Math.round((annotatedImages / totalImages) * 100) : 0;

    return {
      totalImages, annotatedImages, totalAnnotations, completionRate,
      classSorted, typeCounts, perImageSorted, maxClassCount, maxPerImage,
    };
  });

  // 标注类型显示名
  const typeLabels: Record<string, string> = {
    rect: '矩形框', polygon: '多边形', rotated: '旋转框', keypoint: '关键点',
  };
  const typeColors: Record<string, string> = {
    rect: '#58a6ff', polygon: '#3fb950', rotated: '#d2991d', keypoint: '#f85149',
  };
</script>

<div class="modal-overlay" onclick={onClose}>
  <div class="modal" onclick={e => e.stopPropagation()}>
    <div class="modal-header">
      <h3>标注统计</h3>
      <button class="close-btn" onclick={onClose}>×</button>
    </div>
    <div class="modal-body">
      <!-- 概览卡片 -->
      <div class="overview">
        <div class="stat-card">
          <div class="stat-value">{stats.totalImages}</div>
          <div class="stat-label">总图片</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{stats.annotatedImages}</div>
          <div class="stat-label">已标注</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{stats.totalAnnotations}</div>
          <div class="stat-label">标注总数</div>
        </div>
        <div class="stat-card highlight">
          <div class="stat-value">{stats.completionRate}%</div>
          <div class="stat-label">完成率</div>
        </div>
      </div>

      <!-- 完成率进度条 -->
      <div class="section">
        <div class="progress-row">
          <span class="progress-label">标注完成进度</span>
          <span class="progress-num">{stats.annotatedImages}/{stats.totalImages}</span>
        </div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: {stats.completionRate}%"></div>
        </div>
      </div>

      <div class="two-col">
        <!-- 类别统计 -->
        <div class="section">
          <h4>类别分布</h4>
          {#if stats.classSorted.length === 0}
            <p class="empty">暂无标注</p>
          {:else}
            <div class="bar-list">
              {#each stats.classSorted as [className, count]}
                <div class="bar-row">
                  <span class="bar-name" style="color: {getClassColor(className)}">{className}</span>
                  <div class="bar-track">
                    <div class="bar-fill" style="width: {(count / stats.maxClassCount * 100).toFixed(1)}%; background: {getClassColor(className)}"></div>
                  </div>
                  <span class="bar-count">{count}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <!-- 标注类型统计 -->
        <div class="section">
          <h4>标注类型</h4>
          <div class="type-grid">
            {#each Object.entries(stats.typeCounts) as [type, count]}
              <div class="type-card" style="border-left-color: {typeColors[type]}">
                <div class="type-count" style="color: {typeColors[type]}">{count}</div>
                <div class="type-label">{typeLabels[type]}</div>
              </div>
            {/each}
          </div>
        </div>
      </div>

      <!-- 每图标注数排行 -->
      <div class="section">
        <h4>标注数排行（前10）</h4>
        {#if stats.perImageSorted.length === 0 || stats.perImageSorted[0].count === 0}
          <p class="empty">暂无标注</p>
        {:else}
          <div class="bar-list">
            {#each stats.perImageSorted as item}
              <div class="bar-row">
                <span class="bar-name img-name" title={item.name}>{item.name}</span>
                <div class="bar-track">
                  <div class="bar-fill gray" style="width: {(item.count / stats.maxPerImage * 100).toFixed(1)}%"></div>
                </div>
                <span class="bar-count">{item.count}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .modal {
    background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px;
    width: 680px; max-height: 85vh; overflow-y: auto; color: var(--text-primary);
  }
  .modal-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 14px 18px; border-bottom: 1px solid var(--border);
    position: sticky; top: 0; background: var(--bg-secondary); z-index: 1;
  }
  .modal-header h3 { margin: 0; font-size: 16px; }
  .close-btn {
    background: none; border: none; color: var(--text-secondary); font-size: 22px;
    cursor: pointer; padding: 0 4px;
  }
  .close-btn:hover { color: var(--text-primary); }
  .modal-body { padding: 16px 18px; }

  /* 概览卡片 */
  .overview {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px;
  }
  .stat-card {
    background: var(--bg-primary); border: 1px solid var(--border); border-radius: 6px;
    padding: 12px; text-align: center;
  }
  .stat-card.highlight {
    border-color: #238636; background: rgba(35,134,54,0.1);
  }
  .stat-value { font-size: 24px; font-weight: 700; color: var(--text-primary); }
  .stat-card.highlight .stat-value { color: #3fb950; }
  .stat-label { font-size: 11px; color: var(--text-secondary); margin-top: 2px; }

  /* 进度条 */
  .section { margin-bottom: 18px; }
  .section h4 { margin: 0 0 10px; font-size: 13px; color: #58a6ff; }
  .progress-row {
    display: flex; justify-content: space-between; font-size: 12px; color: var(--text-secondary); margin-bottom: 6px;
  }
  .progress-num { color: var(--text-primary); font-weight: 600; }
  .progress-bar-bg {
    height: 8px; background: var(--bg-primary); border-radius: 4px; overflow: hidden;
    border: 1px solid var(--border);
  }
  .progress-bar-fill {
    height: 100%; background: linear-gradient(90deg, #238636, #3fb950);
    border-radius: 4px; transition: width 0.3s ease;
  }

  /* 两列布局 */
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }

  /* 柱状图列表 */
  .bar-list { display: flex; flex-direction: column; gap: 6px; }
  .bar-row {
    display: flex; align-items: center; gap: 8px; font-size: 12px;
  }
  .bar-name {
    width: 70px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 500;
  }
  .img-name { width: 120px; color: var(--text-primary); }
  .bar-track {
    flex: 1; height: 16px; background: var(--bg-primary); border-radius: 3px;
    border: 1px solid var(--bg-tertiary); overflow: hidden;
  }
  .bar-fill {
    height: 100%; border-radius: 2px; transition: width 0.3s ease;
    min-width: 2px;
  }
  .bar-fill.gray { background: var(--text-secondary); }
  .bar-count {
    width: 30px; flex-shrink: 0; text-align: right; color: var(--text-secondary); font-weight: 600;
  }

  /* 标注类型卡片 */
  .type-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .type-card {
    background: var(--bg-primary); border: 1px solid var(--border); border-left-width: 3px;
    border-radius: 4px; padding: 10px; text-align: center;
  }
  .type-count { font-size: 20px; font-weight: 700; }
  .type-label { font-size: 11px; color: var(--text-secondary); margin-top: 2px; }

  .empty { color: var(--text-secondary); font-size: 12px; text-align: center; padding: 12px; }
</style>






