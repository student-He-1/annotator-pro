<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n.svelte';
  import {
    ui, images,
    selectAnnotation, setTool, pushHistory, markModified, showToast,
    addAnnotation, deleteAnnotation, getActiveClass, getNextAnnotationId,
    copyAllToNextImage, copySelectedToNextImage,
    canUndo, canRedo, classColors, COLORS, classes,
    imageModified, saveAnnotations, clearModified,
    captureUndoBaseline, getUndoBaseline, saveAnnotationsNow, applySnapshot,
  } from '$lib/state.svelte';
  import {
    initEngine, resize, render, screenToImage, imageToScreen, hitTestAnnotation, hitTestHandle,
    resizeRectAnnotation, fitToScreen, hitTestPolygonVertex, hitTestPolygonEdge,
    getMinZoom, clampPan,
  } from '$lib/canvas/engine.svelte';
  import type { Annotation, RectAnnotation, RotatedAnnotation, DragHandle, PolygonAnnotation, KeypointAnnotation } from '$lib/types';
  import { magicWand } from '$lib/magicwand';
  import { segment, isModelLoaded, clearCache as clearSamCache } from '$lib/sam';
  import { skeletonFor, getSkeleton } from '$lib/skeletons';

  let canvasEl: HTMLCanvasElement;
  let containerEl: HTMLDivElement;
  let showWelcome = $state(true);
  let imageInfoText = $state('');
  let isPanning = $state(false);
  let panStart = $state({ x: 0, y: 0 });
  let freePanning = $state(false); // 双击进入的自由平移模式，鼠标移动即平移，右键退出

  // select 工具下拖拽已有标注 = 平移（独立状态，避免与画新框的 isDrawing 混淆）
  let moveState = $state<{ ann: Annotation; lastX: number; lastY: number } | null>(null);

  export function getImageInfo() { return imageInfoText; }
  export function getWelcomeVisible() { return showWelcome; }

  // ============================================================
  // Init
  // ============================================================
  onMount(() => {
    initEngine(canvasEl, containerEl);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  });

  // ============================================================
  // Load current image
  // ============================================================
  // 图片加载
  // 竞态守卫：快速连续切图（或批量过程中手动切图）时，多个 Image 会同时在加载。
  // 若不拦截，onload 是「先发后到」的 —— 旧图的 onload 可能晚于新图触发，把 ui.currentImage 写回旧图，
  // 而 render() 的标注是按 currentImageIndex 取的 → 表现为「底片是图A、轮廓是图B」，且不会自愈。
  // loadToken / loadedKey 都是普通变量（非 $state），读写它们不会给 $effect 增加依赖。
  let loadToken = 0;
  let loadedKey = '';   // 当前 ui.currentImage 对应的图片标识（用 dataUrl，重导入会变）
  $effect(() => {
    const idx = ui.currentImageIndex;
    if (idx < 0 || idx >= images.length) {
      loadToken++;              // 作废所有在途加载，避免旧图把已清空的画布填回去
      loadedKey = '';
      ui.imageLoading = false;
      ui.currentImage = null;
      showWelcome = true;
      imageInfoText = '';
      queueMicrotask(render);   // 立刻清空画布，别留着上一张的残影
      return;
    }
    const imgData = images[idx];
    const key = imgData.dataUrl;
    // 同一张图重复触发（导入新图会改动 images 数组，导致本 effect 反复重跑）时直接跳过，
    // 否则每次都会重新置空 + 重载，导入过程中画面会不停闪白。
    if (loadedKey === key) return;
    loadedKey = key;

    const token = ++loadToken;  // 当前这次加载的编号
    // 加载期间不置空 currentImage，也不清屏 —— 保留上一帧底图，界面更连贯。
    // 用 imageLoading 标记，render() 在这段时间只画底图、不画标注，
    // 从而避免「底片还是上一张、轮廓已经是这一张」的错配残影（删图后停留 2~3 秒的现象）。
    ui.imageLoading = true;
    // 立刻重绘一次：此刻底图还是上一张，但 imageLoading 会让 render 跳过标注，
    // 于是旧图上的轮廓会马上消失，而不是等新图 decode 完才一起消失。
    // 用 queueMicrotask 是为了让 render 在 effect 的依赖追踪之外执行，避免多余的重跑。
    queueMicrotask(render);
    const img = new Image();
    img.onload = () => {
      if (token !== loadToken) return;  // 已被更新的加载请求取代，直接丢弃
      ui.currentImage = img;
      ui.imageLoading = false;
      showWelcome = false;
      ui.selectedAnnotation = null;
      ui.polygonPoints = [];
      ui.isDrawing = false;
      ui.drawingAnnotation = null;
      moveState = null;
      imageInfoText = imgData.width + 'x' + imgData.height + ' | ' + imgData.name;
      if (containerEl && img.width <= containerEl.clientWidth && img.height <= containerEl.clientHeight) {
        ui.zoom = 1;
        ui.panX = 0;
        ui.panY = 0;
      } else {
        fitToScreen();
      }
      render();
      // 这里原来会清空 ui.history，导致「切到别的图再切回来就撤不了」。
      // 历史条目自带 imageName，undo() 会自己跳回对应图片，不需要清空。
      // 但要把这张图「本轮最初始的标注」记下来（只记一次），
      // 撤销撤到最底那一步时要还原成它，而不是无条件清空。
      captureUndoBaseline(imgData.name);
    };
    img.src = imgData.dataUrl;
  });

  // ============================================================
  // Mouse Events
  // ============================================================
  let dragStartPos: { x: number; y: number } | null = null;
  let mouseStartImg: { x: number; y: number } | null = null;
  // SAM 工具：记录 mousedown 起点，mouseup 判断点击/拖拽
  let samStart: { x: number; y: number; shift: boolean } | null = null;
  // SAM 拖拽框可视化（屏幕像素坐标）
  let samDragRect = $state<{ left: number; top: number; w: number; h: number } | null>(null);

  /** Alt+左键点在已选多边形的顶点上 → 删掉这个顶点。
   *
   *  这是原来的死代码：它写在 `handleMouseDown` 的 select 分支里，
   *  但函数开头 `e.button === 0 && e.altKey` 早就被当成「平移画布」return 掉了，
   *  所以这段永远不会执行。现在提到平移判定之前，只有「没点中顶点」才落到平移。
   */
  function tryDeletePolygonVertex(imgPos: { x: number; y: number }): boolean {
    if (!ui.selectedAnnotation || ui.selectedAnnotation.type !== 'polygon') return false;
    const vIdx = hitTestPolygonVertex(imgPos.x, imgPos.y);
    if (vIdx < 0) return false;
    const ann = ui.selectedAnnotation as PolygonAnnotation;
    if (ann.points.length <= 3) {
      // 多边形至少 3 个点。点在顶点上但删不掉时也要返回 true，
      // 否则这一下会变成「顺带平移画布」，用户会以为误操作。
      showToast('Polygon needs at least 3 vertices', 'error');
      return true;
    }
    ann.points.splice(vIdx, 1);
    pushHistory();
    render();
    markModified();
    return true;
  }

  function handleMouseDown(e: MouseEvent) {
    // 自由平移模式下忽略 mousedown
    if (freePanning) return;
    // Alt+左键：先判「删多边形顶点」，没命中顶点才当平移用
    if (e.button === 0 && e.altKey && ui.currentTool === 'select' && ui.currentImage && !ui.imageLoading) {
      if (tryDeletePolygonVertex(screenToImage(e.clientX, e.clientY))) return;
    }
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      isPanning = true;
      panStart = { x: e.clientX - ui.panX, y: e.clientY - ui.panY };
      return;
    }
    if (e.button !== 0) return;
    if (!ui.currentImage) return;
    if (ui.imageLoading) return;   // 新图还没 decode 完，此时坐标基准还是上一张，禁止交互

    const imgPos = screenToImage(e.clientX, e.clientY);
    mouseStartImg = imgPos;

    // SAM 工具：记录起点，mouseup 时判断点击还是拖拽
    if (ui.currentTool === 'sam') {
      samStart = { x: imgPos.x, y: imgPos.y, shift: e.shiftKey };
      return;
    }

    if (ui.currentTool === 'select') {
      const handle = hitTestHandle(imgPos.x, imgPos.y);
      if (handle) {
        ui.dragHandle = handle;
        ui.dragStart = { ...imgPos };
        return;
      }
      // Polygon vertex hit test (higher priority than body hit)
      if (ui.selectedAnnotation && ui.selectedAnnotation.type === 'polygon') {
        const vIdx = hitTestPolygonVertex(imgPos.x, imgPos.y);
        if (vIdx >= 0) {
          // Alt+点击删顶点已在函数开头拦掉了，这里只可能是「拖顶点」
          ui.draggingVertex = vIdx;
          ui.dragStart = { ...imgPos };
          return;
        }
      }
      const hit = hitTestAnnotation(imgPos.x, imgPos.y);
      if (hit) {
        selectAnnotation(hit);
        // 记录平移起点（lastX/lastY 用于增量移动，避免绝对偏移累加导致"飞天"）
        moveState = { ann: hit, lastX: imgPos.x, lastY: imgPos.y };
        return;
      }
      selectAnnotation(null);
      moveState = null;
    }

    if (ui.currentTool === 'rect' || ui.currentTool === 'rotated') {
      ui.isDrawing = true;
      ui.dragStart = { ...imgPos };
      if (ui.currentTool === 'rect') {
        ui.drawingAnnotation = {
          type: 'rect', x: imgPos.x, y: imgPos.y, w: 0, h: 0,
          className: getActiveClass(), id: getNextAnnotationId(),
        } as RectAnnotation;
      } else {
        ui.drawingAnnotation = {
          type: 'rotated', cx: imgPos.x, cy: imgPos.y, w: 0, h: 0, angle: 0,
          className: getActiveClass(), id: getNextAnnotationId(),
        } as RotatedAnnotation;
      }
    }

    if (ui.currentTool === 'keypoint') {
      if (!ui.isDrawing) {
        ui.isDrawing = true;
        ui.drawingAnnotation = {
          type: 'keypoint', points: [], className: getActiveClass(), id: getNextAnnotationId(),
          // 记住当前选中的骨架模板。渲染连线、COCO/LabelMe 的类别都靠它，
          // 不能再靠「点数」反推 —— 手动打点时点数一直在变，永远猜不中模板。
          skeletonId: ui.skeletonId,
        } as KeypointAnnotation;
      }
      if (ui.drawingAnnotation && 'points' in ui.drawingAnnotation) {
        const pts = ui.drawingAnnotation.points;
        // 选定了固定点数的模板（人体 17 / 人脸 68 / 手 21 / 自定义）时，点数有上限
        const tpl = (ui.skeletonId && ui.skeletonId !== 'none')
          ? skeletonFor(ui.skeletonId, pts.length)
          : undefined;
        const limit = tpl && tpl.keypoints.length > 0 ? tpl.keypoints.length : Infinity;

        if (pts.length >= limit) {
          showToast(`${tpl?.name || '该骨架'}只有 ${limit} 个点；按 Enter 结束，或换一个骨架模板`, 'info');
          return;
        }

        pts.push({ x: imgPos.x, y: imgPos.y });
        render();
        markModified();

        // 放满模板点数 → 自动收尾。手动打点也该像「一键检测」那样点到为止，
        // 不用记着回车（用户反馈过「标完没进标注列表」，就是漏了这步）。
        if (pts.length >= limit) {
          showToast(`已放满 ${limit} 个点，自动生成 ${tpl?.name || '骨架'}`, 'success');
          finishKeypoint();
        }
        return;
      }
    }

    if (ui.currentTool === 'polygon') {
      ui.polygonPoints.push({ x: imgPos.x, y: imgPos.y, className: getActiveClass() });
      render();
      markModified();
    }

    if (ui.currentTool === 'magicwand') {
      if (!ui.currentImage) return;
      const img = ui.currentImage;
      // 获取原始图片的 ImageData
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = img.width;
      tmpCanvas.height = img.height;
      const tmpCtx = tmpCanvas.getContext('2d')!;
      tmpCtx.drawImage(img, 0, 0);
      const imageData = tmpCtx.getImageData(0, 0, img.width, img.height);

      // 调用魔术棒
      const points = magicWand(imageData, Math.round(imgPos.x), Math.round(imgPos.y), {
        tolerance: ui.magicWandTolerance,
        useContiguous: ui.magicWandContiguous,
        simplifyTolerance: ui.magicWandSimplify,
      });

      if (points.length >= 3) {
        const ann: Annotation = {
          type: 'polygon',
          points: points.map(p => ({ x: p.x, y: p.y })),
          className: getActiveClass(),
          id: getNextAnnotationId(),
        };
        addAnnotation(ann);
        pushHistory();
        selectAnnotation(ann);
        render();
        showToast(`Magic wand: ${points.length} vertices`, 'success');
      } else {
        showToast('No region found, try increasing tolerance', 'error');
      }
    }
  }

  /**
   * SAM 智能分割：点击=正点(Shift=负点)，拖拽=框选
   * 运行模型生成 mask → 轮廓提取 → 多边形标注
   */
  async function runSamSegment(
    start: { x: number; y: number; shift: boolean },
    end: { x: number; y: number },
    isDrag: boolean
  ) {
    if (!ui.currentImage) return;
    if (!isModelLoaded()) {
      showToast('SAM model not loaded. Click SAM button to load model.', 'error');
      return;
    }

    const points = isDrag ? [] : [{ x: start.x, y: start.y, label: (start.shift ? 0 : 1) as 1 | 0 }];
    const box = isDrag ? {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      w: Math.abs(end.x - start.x),
      h: Math.abs(end.y - start.y),
    } : null;

    showToast('SAM running...', 'info');
    try {
      const result = await segment(
        ui.currentImage,
        points,
        box,
        {
          encoderInputSize: 1024,
          maskThreshold: ui.samMaskThreshold,
          simplifyTolerance: ui.samSimplifyTolerance,
          multiMask: ui.samMultiMask,
        }
      );

      if (result.polygon.length >= 3) {
        const ann: Annotation = {
          type: 'polygon',
          points: result.polygon.map(p => ({ x: p.x, y: p.y })),
          className: getActiveClass(),
          id: getNextAnnotationId(),
        };
        addAnnotation(ann);
        pushHistory();
        selectAnnotation(ann);
        render();
        showToast(`SAM: ${result.polygon.length} vertices, IoU=${result.iou.toFixed(2)}`, 'success');
      } else {
        showToast('SAM: no mask generated, try different prompt', 'error');
      }
    } catch (err: any) {
      showToast(`SAM error: ${err.message || err}`, 'error');
    }
  }

  function handleMouseMove(e: MouseEvent) {
    if (freePanning) {
      // 自由平移模式：鼠标移动即平移，以 panStart 为基准
      ui.panX = e.clientX - panStart.x;
      ui.panY = e.clientY - panStart.y;
      render();
      return;
    }
    if (isPanning) {
      ui.panX = e.clientX - panStart.x;
      ui.panY = e.clientY - panStart.y;
      render();
      return;
    }
    if (!ui.currentImage) return;
    const imgPos = screenToImage(e.clientX, e.clientY);
    // 状态栏的鼠标坐标：这里报的是「图像坐标」，会画到状态栏上
    ui.mouseImgX = imgPos.x;
    ui.mouseImgY = imgPos.y;
    ui.mouseOverCanvas = true;

    // SAM 工具：拖拽中更新框选可视化
    if (samStart) {
      const dx = imgPos.x - samStart.x;
      const dy = imgPos.y - samStart.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        const s = imageToScreen(samStart.x, samStart.y);
        const c = imageToScreen(imgPos.x, imgPos.y);
        samDragRect = {
          left: Math.min(s.x, c.x),
          top: Math.min(s.y, c.y),
          w: Math.abs(c.x - s.x),
          h: Math.abs(c.y - s.y),
        };
      }
      return;
    }

    if (ui.dragHandle && ui.selectedAnnotation && ui.dragStart) {
      const ann = ui.selectedAnnotation as RectAnnotation;
      const dx = imgPos.x - ui.dragStart.x;
      const dy = imgPos.y - ui.dragStart.y;
      resizeRectAnnotation(ann, ui.dragHandle.id, dx, dy);
      ui.dragStart = { ...imgPos };
      render();
      markModified();
      return;
    }

    if (ui.draggingVertex >= 0 && ui.selectedAnnotation && ui.selectedAnnotation.type === 'polygon') {
      const ann = ui.selectedAnnotation as PolygonAnnotation;
      ann.points[ui.draggingVertex].x = imgPos.x;
      ann.points[ui.draggingVertex].y = imgPos.y;
      render();
      markModified();
      return;
    }

    // select 工具：平移整个标注（用增量移动，保持形状不变，框紧随鼠标）
    if (moveState) {
      const dx = imgPos.x - moveState.lastX;
      const dy = imgPos.y - moveState.lastY;
      moveAnnotation(moveState.ann, dx, dy);
      moveState.lastX = imgPos.x;
      moveState.lastY = imgPos.y;
      render();
      markModified();
      return;
    }

    if (ui.isDrawing && ui.drawingAnnotation && ui.dragStart) {
      if (ui.drawingAnnotation.type === 'rect') {
        const dx = imgPos.x - ui.dragStart.x;
        const dy = imgPos.y - ui.dragStart.y;
        if (dx >= 0) { (ui.drawingAnnotation as RectAnnotation).x = ui.dragStart.x; (ui.drawingAnnotation as RectAnnotation).w = dx; }
        else { (ui.drawingAnnotation as RectAnnotation).x = imgPos.x; (ui.drawingAnnotation as RectAnnotation).w = -dx; }
        if (dy >= 0) { (ui.drawingAnnotation as RectAnnotation).y = ui.dragStart.y; (ui.drawingAnnotation as RectAnnotation).h = dy; }
        else { (ui.drawingAnnotation as RectAnnotation).y = imgPos.y; (ui.drawingAnnotation as RectAnnotation).h = -dy; }
      } else if (ui.drawingAnnotation.type === 'rotated') {
        const dx = imgPos.x - ui.dragStart.x;
        const dy = imgPos.y - ui.dragStart.y;
        (ui.drawingAnnotation as RotatedAnnotation).cx = ui.dragStart.x + dx / 2;
        (ui.drawingAnnotation as RotatedAnnotation).cy = ui.dragStart.y + dy / 2;
        (ui.drawingAnnotation as RotatedAnnotation).w = Math.abs(dx);
        (ui.drawingAnnotation as RotatedAnnotation).h = Math.abs(dy);
        (ui.drawingAnnotation as RotatedAnnotation).angle = Math.atan2(dy, dx) * 180 / Math.PI;
      }
      render();
      markModified();
    }
  }

  function handleMouseUp(e: MouseEvent) {
    if (isPanning) { isPanning = false; return; }

    // SAM 工具：判断点击还是拖拽，运行分割
    if (samStart && ui.currentTool === 'sam') {
      const imgPos = screenToImage(e.clientX, e.clientY);
      const dx = imgPos.x - samStart.x;
      const dy = imgPos.y - samStart.y;
      const isDrag = Math.abs(dx) > 5 || Math.abs(dy) > 5;
      const start = samStart;
      samStart = null;
      samDragRect = null;
      runSamSegment(start, imgPos, isDrag);
      return;
    }

    if (ui.dragHandle) { ui.dragHandle = null; ui.dragStart = null; pushHistory(); return; }
    if (ui.draggingVertex >= 0) { ui.draggingVertex = -1; ui.dragStart = null; pushHistory(); return; }
    if (moveState) { moveState = null; pushHistory(); return; }

    if (ui.isDrawing && ui.drawingAnnotation) {
      const da = ui.drawingAnnotation;
      if (da.type === 'rect' || da.type === 'rotated') {
        const w = (da as any).w || 0;
        const h = (da as any).h || 0;
        if (w > 5 && h > 5) {
          const ann = { ...da } as Annotation;
          ann.id = getNextAnnotationId();
          addAnnotation(ann);
          ui.isDrawing = false;
          ui.drawingAnnotation = null;
          ui.dragStart = null;
          pushHistory();
          selectAnnotation(ann);
          render();
        } else {
          ui.isDrawing = false;
          ui.drawingAnnotation = null;
          ui.dragStart = null;
        }
      }
      render();
    }
  }

  /** 当前是否有「按下后还没松开」的拖拽手势。 */
  function isGestureActive(): boolean {
    return isPanning || freePanning || !!samStart || !!ui.dragHandle
      || ui.draggingVertex >= 0 || !!moveState || (ui.isDrawing && !!ui.drawingAnnotation);
  }

  /** 鼠标在画布外松开时，canvas 上根本收不到 mouseup，
   *  于是 isDrawing / dragHandle / draggingVertex / moveState / isPanning 永远不复位 ——
   *  表现就是「拖出画布松手，之后鼠标一动标注跟着乱飞，得再点一下画布才恢复」。
   *
   *  这里在 window 上补一层兜底。canvas 自己的 onmouseup/onmousemove 仍然负责画布内的情况，
   *  用 e.target 判断避免同一个事件被处理两遍（moveState 是增量移动，跑两遍虽然 dx=0 不会错，
   *  但会白画一帧）。
   */
  function handleWindowMouseUp(e: MouseEvent) {
    if (e.target === canvasEl) return;
    handleMouseUp(e);
  }

  function handleWindowMouseMove(e: MouseEvent) {
    if (e.target === canvasEl) return;
    if (!isGestureActive()) return;
    handleMouseMove(e);
  }

  function handleMouseLeave() {
    ui.mouseOverCanvas = false;
  }

  function handleDoubleClick(e: MouseEvent) {
    if (ui.currentTool === 'polygon' && ui.polygonPoints.length >= 3) {
      finishPolygon();
      return;
    }
    if (ui.currentTool === 'select' && ui.selectedAnnotation && ui.selectedAnnotation.type === 'polygon') {
      const imgPos = screenToImage(e.clientX, e.clientY);
      const edgeIdx = hitTestPolygonEdge(imgPos.x, imgPos.y);
      if (edgeIdx >= 0) {
        const ann = ui.selectedAnnotation as PolygonAnnotation;
        ann.points.splice(edgeIdx + 1, 0, { x: imgPos.x, y: imgPos.y });
        pushHistory();
        render();
        markModified();
        return;
      }
    }
    // 其他情况：双击进入自由平移模式
    if (ui.currentImage) {
      freePanning = true;
      panStart = { x: e.clientX - ui.panX, y: e.clientY - ui.panY };
      showToast('自由平移模式：移动鼠标平移画布，右键退出', 'info');
    }
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = canvasEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.max(getMinZoom(), Math.min(10, ui.zoom * factor));
    const worldX = (mx - ui.panX - canvasEl.width / 2) / ui.zoom;
    const worldY = (my - ui.panY - canvasEl.height / 2) / ui.zoom;
    ui.panX = mx - worldX * newZoom - canvasEl.width / 2;
    ui.panY = my - worldY * newZoom - canvasEl.height / 2;
    ui.zoom = newZoom;
    clampPan();
    render();
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    // 自由平移模式下：右键退出
    if (freePanning) {
      freePanning = false;
      showToast('已退出自由平移模式', 'info');
      return;
    }
    const imgPos = screenToImage(e.clientX, e.clientY);
    const hit = hitTestAnnotation(imgPos.x, imgPos.y);
    if (hit) {
      selectAnnotation(hit);
      showContextMenu(e.clientX, e.clientY, hit);
    }
  }

  // ============================================================
  // Drawing helpers
  // ============================================================
  function finishPolygon() {
    if (ui.polygonPoints.length < 3) return;
    const ann: Annotation = {
      type: 'polygon',
      points: [...ui.polygonPoints.filter(p => p.x != null)],
      className: ui.polygonPoints[0]?.className || getActiveClass(),
      id: getNextAnnotationId(),
    };
    addAnnotation(ann);
    ui.polygonPoints = [];
    pushHistory();
    selectAnnotation(ann);
    render();
  }

  function finishKeypoint() {
    if (!ui.drawingAnnotation || !('points' in ui.drawingAnnotation) || ui.drawingAnnotation.points.length === 0) return;
    const ann = { ...ui.drawingAnnotation } as Annotation;
    ann.id = getNextAnnotationId();
    addAnnotation(ann);
    ui.isDrawing = false;
    ui.drawingAnnotation = null;
    pushHistory();
    selectAnnotation(ann);
    render();
  }

  // ============================================================
  // Context Menu
  // ============================================================
  let contextMenu = $state<{ x: number; y: number; ann: Annotation } | null>(null);

  function showContextMenu(x: number, y: number, ann: Annotation) {
    contextMenu = { x, y, ann };
  }

  function hideContextMenu() { contextMenu = null; }

  // 平移标注：按类型整体移动，保持形状
  function moveAnnotation(ann: Annotation, dx: number, dy: number) {
    if (ann.type === 'rect') {
      const r = ann as RectAnnotation;
      r.x += dx; r.y += dy;
    } else if (ann.type === 'rotated') {
      const rt = ann as RotatedAnnotation;
      rt.cx += dx; rt.cy += dy;
    } else if (ann.type === 'polygon' || ann.type === 'keypoint') {
      ann.points.forEach(p => { p.x += dx; p.y += dy; });
    }
  }

  function handleContextDelete() {
    if (!contextMenu) return;
    deleteAnnotation(contextMenu.ann);
    pushHistory();
    render();
    hideContextMenu();
    showToast(t('annotationDeleted'), 'info');
  }

  function handleContextCopy() {
    if (!contextMenu) return;
    const copy = JSON.parse(JSON.stringify(contextMenu.ann));
    copy.id = getNextAnnotationId();
    copy.x = (copy.x || 0) + 20;
    copy.y = (copy.y || 0) + 20;
    if (copy.cx) copy.cx += 20;
    if (copy.cy) copy.cy += 20;
    if (copy.points) copy.points = copy.points.map((p: any) => ({ x: p.x + 20, y: p.y + 20 }));
    addAnnotation(copy);
    pushHistory();
    selectAnnotation(copy);
    render();
    hideContextMenu();
    showToast('Copied', 'success');
  }

  // ============================================================
  // Keyboard
  // ============================================================
  function matchShortcut(e: KeyboardEvent, shortcut: string): boolean {
    const parts = shortcut.toLowerCase().split('+');
    const hasCtrl = parts.includes('ctrl');
    const hasShift = parts.includes('shift');
    const hasAlt = parts.includes('alt');
    const key = parts[parts.length - 1];
    if (hasCtrl !== (e.ctrlKey || e.metaKey)) return false;
    if (hasShift !== e.shiftKey) return false;
    if (hasAlt !== e.altKey) return false;
    const eKey = e.key.toLowerCase();
    if (key === 'delete') return eKey === 'delete' || eKey === 'backspace';
    if (key === '=') return eKey === '=' || eKey === '+';
    if (key === '-') return eKey === '-' || eKey === '_';
    return eKey === key;
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;

    if (ui.recordingShortcut) {
      e.preventDefault();
      const parts: string[] = [];
      if (e.ctrlKey || e.metaKey) parts.push('ctrl');
      if (e.shiftKey) parts.push('shift');
      if (e.altKey) parts.push('alt');
      let key = e.key.toLowerCase();
      if (key === 'control' || key === 'shift' || key === 'alt' || key === 'meta') return;
      parts.push(key);
      const newShortcut = parts.join('+');
      const conflict = Object.entries(ui.shortcuts).find(([k, v]) => v === newShortcut && k !== ui.recordingShortcut);
      if (conflict) {
        showToast(`${t('shortcutConflict')}: ${conflict[0]}`, 'error');
        return;
      }
      (ui.shortcuts as any)[ui.recordingShortcut] = newShortcut;
      ui.recordingShortcut = null;
      showToast('Shortcut recorded', 'success');
      return;
    }

    if (matchShortcut(e, ui.shortcuts.undo)) { e.preventDefault(); undo(); return; }
    if (matchShortcut(e, ui.shortcuts.redo) || matchShortcut(e, ui.shortcuts.redoAlt)) { e.preventDefault(); redo(); return; }

    // 绘制中 Backspace/Delete 删除最后一个点（优先于删除选中标注）
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.metaKey) {
      if (ui.currentTool === 'polygon' && ui.polygonPoints.length > 0) {
        e.preventDefault();
        ui.polygonPoints.pop();
        render();
        if (ui.polygonPoints.length === 0) showToast('已清空所有点', 'info');
        return;
      }
      if (ui.currentTool === 'keypoint' && ui.isDrawing && ui.drawingAnnotation && 'points' in ui.drawingAnnotation) {
        e.preventDefault();
        const pts = (ui.drawingAnnotation as any).points;
        if (pts.length > 0) {
          pts.pop();
          render();
          if (pts.length === 0) {
            ui.isDrawing = false;
            ui.drawingAnnotation = null;
            showToast('已清空所有点', 'info');
          }
        }
        return;
      }
    }

    if (matchShortcut(e, ui.shortcuts.delete)) { e.preventDefault(); deleteSelected(); return; }
    if (matchShortcut(e, ui.shortcuts.copy)) { e.preventDefault(); copySelected(); return; }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      const copied = copyAllToNextImage();
      if (copied > 0 && ui.currentImageIndex < images.length - 1) {
        ui.currentImageIndex = ui.currentImageIndex + 1;
        pushHistory();
        render();
        showToast(`Copied ${copied} annotation(s) to next image`, 'success');
      } else {
        showToast('No annotations to copy or no next image', 'error');
      }
      return;
    }
    if (matchShortcut(e, ui.shortcuts.zoomIn)) { e.preventDefault(); ui.zoom = Math.min(10, ui.zoom * 1.2); clampPan(); render(); return; }
    if (matchShortcut(e, ui.shortcuts.zoomOut)) { e.preventDefault(); ui.zoom = Math.max(getMinZoom(), ui.zoom / 1.2); clampPan(); render(); return; }
    if (matchShortcut(e, ui.shortcuts.fit)) { e.preventDefault(); fitToScreen(); render(); return; }
    // Ctrl+S：立刻写盘（不再走 500ms 防抖），状态栏当场变「已保存」
    if (matchShortcut(e, ui.shortcuts.save)) {
      e.preventDefault();
      if (saveAnnotationsNow()) showToast(t('saved'), 'success');
      return;
    }

    if (e.key.toLowerCase() === ui.shortcuts.select && !e.ctrlKey && !e.metaKey) { setTool('select'); return; }
    if (e.key.toLowerCase() === ui.shortcuts.rect && !e.ctrlKey && !e.metaKey) { setTool('rect'); return; }
    if (e.key.toLowerCase() === ui.shortcuts.polygon && !e.ctrlKey && !e.metaKey) { setTool('polygon'); return; }
    if (e.key.toLowerCase() === ui.shortcuts.rotated && !e.ctrlKey && !e.metaKey) { setTool('rotated'); return; }
    if (e.key.toLowerCase() === ui.shortcuts.keypoint && !e.ctrlKey && !e.metaKey) { setTool('keypoint'); return; }
    if (ui.shortcuts.sam && e.key.toLowerCase() === ui.shortcuts.sam && !e.ctrlKey && !e.metaKey) { setTool('sam'); return; }
    // 工具栏一直标着「魔术棒 W」，但以前这里根本没接这个键
    if (ui.shortcuts.magicwand && e.key.toLowerCase() === ui.shortcuts.magicwand && !e.ctrlKey && !e.metaKey) { setTool('magicwand'); return; }

    if (e.key === 'Enter') {
      if (ui.currentTool === 'polygon' && ui.polygonPoints.length >= 3) finishPolygon();
      else if (ui.currentTool === 'keypoint' && ui.isDrawing) finishKeypoint();
    }

    if (e.key === 'Escape') {
      // 自由平移模式下：Escape 退出
      if (freePanning) {
        freePanning = false;
        showToast('已退出自由平移模式', 'info');
        return;
      }
      ui.isDrawing = false;
      ui.drawingAnnotation = null;
      ui.polygonPoints = [];
      ui.selectedAnnotation = null;
      setTool('select');
      render();
    }
  }

  function deleteSelected() {
    if (ui.selectedAnnotation) {
      deleteAnnotation(ui.selectedAnnotation);
      pushHistory();
      render();
      showToast(t('annotationDeleted'), 'info');
    }
  }

  function copySelected() {
    if (!ui.selectedAnnotation) return;
    const copy = JSON.parse(JSON.stringify(ui.selectedAnnotation));
    copy.id = getNextAnnotationId();
    copy.x = (copy.x || 0) + 20;
    copy.y = (copy.y || 0) + 20;
    if (copy.cx) copy.cx += 20;
    if (copy.cy) copy.cy += 20;
    if (copy.points) copy.points = copy.points.map((p: any) => ({ x: p.x + 20, y: p.y + 20 }));
    addAnnotation(copy);
    pushHistory();
    selectAnnotation(copy);
    render();
  }

  // ============================================================
  // Undo/Redo
  // ============================================================
  /** 把当前图片切到指定名字（已经在它上面就什么都不做） */
  function focusImageByName(name: string) {
    if (images[ui.currentImageIndex]?.name === name) return;
    const idx = images.findIndex(img => img.name === name);
    if (idx >= 0) ui.currentImageIndex = idx;
  }

  /** 撤销「history[index] 这次操作」时，这张图该回到哪个状态。
   *
   *  历史里可能混着别的图的操作（画 A → 切到 B → 画 B），
   *  所以不能无脑用 history[index-1]，得往回找**同一张图**上一次记录的状态。
   *  找不到说明这是这张图本轮第一次被改动 → 用它加载时的初始基线。
   *  快照里同时含 annotations 和分类标签 labels（两种模式共用同一套撤销）。
   */
  function snapshotBefore(curName: string, fromIndex: number): { annotations: Annotation[]; labels: string[] } {
    for (let j = fromIndex; j >= 0; j--) {
      const e = ui.history[j];
      if (e.imageName === curName) return { annotations: e.annotations, labels: e.labels || [] };
    }
    return getUndoBaseline(curName);
  }

  function undo() {
    if (ui.historyIndex < 0) return;
    // cur = 这次要撤销掉的那一步，要还原的是它所在的图
    const cur = ui.history[ui.historyIndex];
    ui.historyIndex = ui.historyIndex - 1;

    applySnapshot(cur.imageName, snapshotBefore(cur.imageName, ui.historyIndex));
    focusImageByName(cur.imageName);

    ui.selectedAnnotation = null;
    ui.drawingAnnotation = null;
    ui.isDrawing = false;
    ui.polygonPoints = [];
    render();
    saveAnnotations();
  }

  function redo() {
    if (ui.historyIndex >= ui.history.length - 1) return;
    ui.historyIndex = ui.historyIndex + 1;
    const entry = ui.history[ui.historyIndex];
    applySnapshot(entry.imageName, { annotations: entry.annotations, labels: entry.labels || [] });
    if (entry.imageName !== images[ui.currentImageIndex]?.name) {
      const idx = images.findIndex(img => img.name === entry.imageName);
      if (idx >= 0) ui.currentImageIndex = idx;
    }
    ui.selectedAnnotation = null;
    render();
    saveAnnotations();
  }

  // ============================================================
  // Expose
  // ============================================================
  export { handleMouseDown, handleMouseMove, handleMouseUp, handleDoubleClick, handleWheel, handleContextMenu, handleKeyDown, undo, redo, deleteSelected, copySelected, fitToScreen };
</script>

<svelte:window onkeydown={handleKeyDown} onmouseup={handleWindowMouseUp} onmousemove={handleWindowMouseMove} />

<div class="canvas-container" class:free-panning={freePanning} bind:this={containerEl}>
  {#if showWelcome}
    <div class="welcome">
      <div class="welcome-icon">🖼</div>
      <div class="welcome-text">{t('welcomeText')}</div>
      <div class="welcome-hint">{t('welcomeHint')}</div>
    </div>
  {/if}
  <canvas bind:this={canvasEl}
    onmousedown={handleMouseDown}
    onmousemove={handleMouseMove}
    onmouseup={handleMouseUp}
    onmouseleave={handleMouseLeave}
    ondblclick={handleDoubleClick}
    onwheel={handleWheel}
    oncontextmenu={handleContextMenu}>
  </canvas>

  <!-- SAM 拖拽框选可视化 -->
  {#if samDragRect}
    <div class="sam-drag-rect" style="left:{samDragRect.left}px;top:{samDragRect.top}px;width:{samDragRect.w}px;height:{samDragRect.h}px"></div>
  {/if}

  <!-- 绘制状态提示 -->
  {#if (ui.currentTool === 'polygon' && ui.polygonPoints.length > 0) || (ui.currentTool === 'keypoint' && ui.isDrawing)}
    {@const kpTpl = ui.skeletonId && ui.skeletonId !== 'none' ? getSkeleton(ui.skeletonId) : null}
    {@const kpPlaced = (ui.drawingAnnotation as any)?.points?.length || 0}
    <div class="drawing-hint">
      <span class="drawing-count">
        {ui.currentTool === 'polygon'
          ? `多边形：${ui.polygonPoints.length} 点`
          : (kpTpl && kpTpl.keypoints.length > 0
              ? `${kpTpl.name}：${kpPlaced} / ${kpTpl.keypoints.length} 点`
              : `关键点：${kpPlaced} 点`)}
      </span>
      <span class="drawing-keys">
        {ui.currentTool === 'keypoint' ? '放满自动结束 · ' : ''}Enter 结束 · Backspace 删上一点 · Escape 取消
      </span>
    </div>
  {/if}

  <!-- 自由平移模式提示 -->
  {#if freePanning}
    <div class="drawing-hint" style="border-color: var(--accent-blue);">
      <span class="drawing-count" style="color: var(--accent-blue);">自由平移模式</span>
      <span class="drawing-keys">移动鼠标平移画布 · 右键点击退出</span>
    </div>
  {/if}

  {#if contextMenu}
    <div class="context-menu" style="left:{contextMenu.x}px;top:{contextMenu.y}px">
      <div class="context-item" onclick={handleContextDelete}>🗑 {t('delete')} <span class="shortcut">Del</span></div>
      <div class="context-item" onclick={handleContextCopy}>📋 {t('copy')} <span class="shortcut">Ctrl+D</span></div>
    </div>
  {/if}
</div>

{#if contextMenu}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="context-overlay" onclick={hideContextMenu}></div>
{/if}

<style>
  .canvas-container {
    flex: 1; position: relative; overflow: hidden;
    background: var(--canvas-bg);
    background-image:
      linear-gradient(45deg, var(--canvas-grid1) 25%, transparent 25%),
      linear-gradient(-45deg, var(--canvas-grid1) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, var(--canvas-grid1) 75%),
      linear-gradient(-45deg, transparent 75%, var(--canvas-grid1) 75%);
    background-size: 20px 20px;
    background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
  }
  .canvas-container.free-panning {
    cursor: grabbing;
  }
  .canvas-container.free-panning canvas {
    cursor: grabbing;
  }
  canvas { display: block; position: absolute; top: 0; left: 0; }
  .sam-drag-rect {
    position: absolute; border: 1.5px dashed #58a6ff; background: rgba(88,166,255,0.12);
    pointer-events: none; z-index: 50; border-radius: 2px;
  }
  .welcome {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; color: var(--text-muted); pointer-events: none; z-index: 1;
  }
  .welcome-icon { font-size: 64px; margin-bottom: 16px; opacity: 0.3; }
  .welcome-text { font-size: 14px; }
  .welcome-hint { font-size: 12px; margin-top: 8px; opacity: 0.5; }

  .drawing-hint {
    position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
    background: rgba(22,27,34,0.95); border: 1px solid #3fb950; border-radius: 6px;
    padding: 6px 14px; font-size: 12px; color: var(--text-primary);
    display: flex; align-items: center; gap: 12px; z-index: 100;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  }
  .drawing-count { color: #3fb950; font-weight: 600; }
  .drawing-keys { color: var(--text-secondary); font-size: 11px; }

  .context-menu {
    position: fixed; z-index: 1500; background: var(--bg-secondary); border: 1px solid var(--border);
    border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    min-width: 180px; padding: 4px;
  }
  .context-item {
    padding: 6px 12px; font-size: 12px; cursor: pointer; border-radius: 4px;
    color: var(--text-secondary); display: flex; align-items: center; gap: 8px;
    transition: background 150ms;
  }
  .context-item:hover { background: var(--border); color: var(--text-primary); }
  .context-item .shortcut { margin-left: auto; font-size: 10px; color: var(--text-muted); font-family: 'JetBrains Mono', monospace; }
  .context-overlay { position: fixed; inset: 0; z-index: 1499; }
</style>


