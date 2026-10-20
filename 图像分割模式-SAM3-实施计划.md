# 图像分割模式（SAM3 · 自动驾驶）实施计划

> ⚠️ **本文件已被 [图像分割模式-实施方案.md](./图像分割模式-实施方案.md) 取代。**
> 保留作为原始素材与决策记录，但下面 3 处已过时，**冲突时以新方案为准**：
>
> 1. 本文件 §10 风险 12 提到的 sidecar 路径问题更严重 —— **交接文档里写的启动路径本身就是错的**
>    （`src-tauri\target\...` 不存在），新方案列为首要前置项。
> 2. 本文件 §5/§8 假设「现有分支只加 if 即可」，实际有 **8 处 `!== 'classification'`** 需要等价收紧，
>    否则分割模式会误入检测分支。
> 3. 本文件 §6.3 的实例掩膜导出到 `<basename>/` 子目录，**与第 12 批「导出不建子目录」的决定冲突**，
>    新方案改为平铺 + 前缀。
>
> 目标：在不破坏现有「目标检测 / 图像分类」两模式的前提下，新增第三个工作模式 **图像分割**，
> 基于本地 SAM3 做**语义分割 + 实例分割**，面向自动驾驶，导出 Cityscapes / COCO / 实例掩膜 / U-Net 四种格式。
>
> 本文件只是计划。**开工前不动任何代码**（含后端）。

---

## 0. 已拍板的决策（来自用户）

| # | 决策 |
|---|---|
| 1 | 掩膜要**真·像素级**：后端额外返回 mask，前端存真掩膜（不是只存多边形） |
| 2 | 一期**语义分割 + 实例分割一起做** |
| 3 | 一期导出**四种格式全要**：Cityscapes 语义 PNG、COCO 实例 JSON、实例掩膜 PNG、U-Net mask |
| 4 | 类别：**预置一套自动驾驶类别 + 可编辑** |
| 5 | 硬约束：**加法式实现**，现有两模式的功能与数据不受影响 |

---

## 1. 数据模型（唯一真值 = 一张「索引图」）

**不要**为每个实例各存一张位图（1920×1080 逐实例 = 2 MB/实例，爆炸）。
真值是一张与原图同尺寸的**索引图** `Uint8Array(W*H)`：`0`=背景，`k`(1..N)=第 k 个 region。
一张图同时支撑：语义（ordinal→类别）、实例（ordinal 天然非重叠）、渲染、命中测试（`map[y*W+x]` 直接取）。

新增类型（`src/lib/types.ts`）：

```ts
type MaskRegionKind = 'instance' | 'stuff';   // thing 有实例身份；stuff 是道路/天空这类语义区域
type MaskRegionSource = 'pcs' | 'point' | 'box' | 'brush';

interface MaskRegion {
  ordinal: number;          // 索引图像素值（1-based）
  className: string;
  kind: MaskRegionKind;
  score: number;
  source: MaskRegionSource;
  box?: { x1: number; y1: number; x2: number; y2: number };
  hidden?: boolean;
  area?: number;
}

interface ImageMask {
  width: number; height: number;
  counts: number[];         // 行主序行程编码（COCO counts 的行主序版）
  regions: MaskRegion[];
  dirty?: boolean;
}

interface ProjectMask {     // 工程文件里：counts 用逗号串，绝不用数组
  width: number; height: number;
  counts: string;
  regions: Omit<MaskRegion, 'area'>[];
}

type WorkMode = 'detection' | 'classification' | 'segmentation';
```

`ProjectFile` 扩展（全部可选，旧工程零改动可读）：`masks?: Record<string, ProjectMask>`、
`settings.workMode` 放宽为三值、`settings.segmentation?: { overlayMode, overlayOpacity, cityscapesMap }`。

**与 `annotations` 的关系**：彼此独立、互不写入。分割模式下 `annotations[name]` 恒为空，
`masks[name]` 是唯一数据源。类别复用全局 `classes` / `classColors`。

---

## 2. 后端改动（`src-tauri/sidecar/sam_server.py`）

原则：**只加可选字段，默认行为字节级不变**（老前端连新后端、新前端连旧后端都能降级到 polygon）。

| 路由 | 新增 | 说明 |
|---|---|---|
| `/predict` | `return_mask: bool = False` → `mask_png: Optional[str]` | 单实例二值 PNG（值 0/255），`Image.fromarray` 编码 |
| `/pcs` | `return_mask: bool = False` → `mask_png: Optional[str]` | **一张索引图 PNG**（值 k = instances[k-1]），不是每实例一张 |

- masks 已是**原图分辨率**（已在 sam3 内部做过 interpolate），后端**无需 resize**。
- 编码用 **PNG**（传输）：索引图 30~80 KB → base64 40~110 KB，与实例数几乎无关。
- **落盘**反过来用 **RLE counts 串**（精确、免 PNG 往返保真疑虑）。
- **不要**用原始位打包 base64（1920×1080 单实例 = 345 KB，10 实例 3.4 MB/图）。
- 不新增路由；`/pcs` 里 `idx[masks[i][0]] = i+1` 顺序即优先级（后写覆盖先写）。

---

## 3. 前端渲染（`src/lib/canvas/engine.svelte.ts`）

用**离屏 overlay canvas**（尺寸=原图像素 W×H），仅在掩膜变化时重建一次，渲染时一次 `drawImage` 缩放贴上：

```
// render() 在 ctx.drawImage(ui.currentImage,...) 之后插入
if (ui.workMode === 'segmentation' && ui.maskShowOverlay && !ui.imageLoading) {
  const ov = buildOverlay(currentName, ui.maskOverlayMode);
  ctx.save();
  ctx.globalAlpha = ui.maskOverlayOpacity;
  ctx.imageSmoothingEnabled = false;          // 必关，否则边缘混出假颜色
  ctx.drawImage(ov, -hw, -hh, imgW, imgH);
  ctx.restore();
}
```

- 坐标系**复用**「图片中心为原点 + `-hw/-hh`」，`screenToImage/imageToScreen` 一行不改。
- 命中测试新增 `hitTestMask(imgX, imgY)`，实现就是查表 `map[y*W+x]`，不做几何判断。
- overlay canvas 只在 1 张上缓存（8.3 MB）；`imageLoading` 期间必须一起跳过（否则「底片 A + 掩膜 B」）。

---

## 4. 交互设计

分割模式工具栏（按模式整体切换，**不改现有 `tools` 列表**）：`seg_select`(V) / `seg_text`(T) /
`seg_point`(B) / `seg_box`(G)；`seg_brush`(W) / `seg_eraser`(E) 放 Phase 2。
分割模式下隐藏「导入 VOC/COCO/LabelMe / 质量校验 / YOLO / SAM 弹窗」。

**主力工作流（文本提示）**：
1. 面板输入文本 → 复用 `normalizePrompt()`，**扩充驾驶词表**（人行道→sidewalk、红绿灯→traffic light、
   交通标志→traffic sign、护栏→fence、电线杆→pole、骑手→rider、植被→vegetation…）。
2. `segmentByText(..., { withMask: true })` → `/pcs` 带 `return_mask=true`。
3. 前端解码索引图 → `ui.maskCandidates` 半透明叠加；列表逐项：得分/像素面积/box/类别下拉/接受·丢弃，
   顶部「接受全部 / 全部丢弃」。
4. **thing**（car/person…）→ 多实例逐个接受 → COCO 实例；**stuff**（road/sky…）→ 整片接受为一个
   `kind:'stuff'` region → 只进语义图。
5. 接受 → `maskStore.acceptCandidate` → `captureMaskBaseline` → `pushMaskHistory` → `render()` → `markModified()`。

复用关系：`ui.samPcsPreview` 仍用于 hover 轮廓高亮；新增 `ui.maskCandidates` 做真实半透明叠加。
**不动检测模式原有的 SAM/PCS 面板**，新面板是独立组件。

---

## 5. 逐文件改动清单

### 新增（独立模块，零侵入）

| 路径 | 内容 |
|---|---|
| `src/lib/segmentation/maskStore.ts` | 索引图/counts/regions 唯一读写入口：decode/encode、accept 索引图、accept/delete region、`repack`、`flush`、LRU 解码缓存、epoch、`getImagesWithMasks()` |
| `src/lib/segmentation/maskHistory.ts` | 掩膜专用撤销栈（存 `{name, countsStr, regionsJson}` 字符串），`maskUndo/maskRedo/canMaskUndo/captureMaskBaseline` |
| `src/lib/segmentation/maskOverlay.ts` | 离屏 overlay canvas 构建与缓存（instance/class 着色） |
| `src/lib/segmentation/classes-preset.ts` | 自动驾驶预置类别（19 类 + thing/stuff 标记 + Cityscapes trainId 表） |
| `src/lib/segmentation/samMask.ts` | `predictWithMask()/pcsWithMask()`、`decodeMaskPngToIndexMap()`（`sam.ts` 不动） |
| `src/lib/export/segmentation-export.ts` | 四套导出 + label map + COCO RLE 编码 |
| `src/components/SegmentationPanel.svelte` | 分割面板：候选列表、区域列表、overlay 开关、阈值、预置类别按钮、四项导出 |

### 改动（全是「加分支/加字段」，逐条说明为什么安全）

| 路径 | 改什么 | 安全性 |
|---|---|---|
| `src/lib/types.ts` | `WorkMode` 加三值；`ToolType` 加 `seg_*`；新增掩膜类型；`ProjectFile` 加 `masks?`/`settings.segmentation?` | 纯类型，`Annotation` 一个字不改 |
| `src/lib/state.svelte.ts` | `ui.workMode` 加三值；`ui` 加 `maskShowOverlay/maskOverlayMode/maskOverlayOpacity/maskTool/maskCandidates/maskEpoch/maskRegions/maskImageCount/segText/segThreshold`；`getCurrentModeCount/Unit/getLabeledImageCount` 各加一分支 | 现有两分支代码不动，只加 `if` |
| `src/App.svelte` | 模式占位卡去掉 `disabled`、`onclick={() => selectMode('segmentation')}`、文案改「语义/实例分割」；`handleExportCurrent`/`handleBatchExport` 各加分割分支；分割模式隐藏导入入口 | 导出函数是「先按模式分流」，加前置 `if` 即可 |
| `src/components/Toolbar.svelte` | 工具组按模式选列表（新增 `segTools`）；隐藏导入/质量/YOLO/SAM；undo/redo `disabled` 加 `canMaskUndo()` | 现有 `tools` 与渲染分支保留 |
| `src/components/Canvas.svelte` | `handleMouse*` 最前面加 `if (ui.workMode==='segmentation') { handleSeg*; return; }`；图片 `$effect` 的 `onload` 加 `maskStore.onImageChange(name)`；`undo/redo` 前置掩膜栈分支；`handleKeyDown` 加 seg 快捷键 | 全部「早返回式新分支」，检测/分类路径一行不改 |
| `src/lib/canvas/engine.svelte.ts` | `render()` 插入 overlay 块；`drawSegSelection()`；新增 `hitTestMask` | 新块由 `ui.workMode==='segmentation'` 门控 |
| `src/lib/project.svelte.ts` | `buildProjectFile()` 加 `masks` 与 `settings.segmentation`；`loadProjectFromFile()` 加恢复分支（懒解码），工程里多出的 mask 名静默跳过 | 「有则处理」可选分支，旧工程走原路径 |
| `src/components/PropertiesPanel.svelte` | 面板与导出区块加 `{:else if ui.workMode === 'segmentation'}` 分支 | 新 `{:else if}` 不改原两分支 |
| `StatisticsModal / BatchOperationsModal / Sidebar / StatusBar` | 各加分割分支（统计区域数/类别像素占比、badge 显示区域数） | 均为加分支 |
| `src/lib/export/formats.ts` | 只在 `formatLabel()` 加三个新格式中文名 | 新 case 不改旧 case |
| `src/lib/i18n.svelte.ts` | zh/en 加 seg 工具名与提示 | 纯字典 |
| `src-tauri/sidecar/sam_server.py` | §2 的可选字段 + `/pcs` 索引图合成 | 默认 `return_mask=False`，现有响应结构不变 |
| `src-tauri/tauri.conf.json` | **建议**：`bundle.resources` 把 `sidecar/sam_server.py` 复制到 exe 旁 | 见 §8 风险 12 |

`src-tauri/src/lib.rs` **不需要改**（`save_file_base64` 已自动建父目录）。

---

## 6. 四套导出（落点 `src/lib/export/segmentation-export.ts`）

统一先 `buildLabelPixels(mask, mapFn)` 生成 `Uint8Array(W*H)` 标签图，三种共用，只有 `mapFn` 不同。

1. **Cityscapes 语义 PNG**：`mapFn = region => cityscapesMap[cls] ?? CITYSCAPES_19[cls] ?? 255`。
   **必须用 trainId(0..18) 而非 labelId(0..33)**；**未映射写 255（void），绝不写 0**（0=road）。
   文件 `<basename>_labelTrainIds.png`。
2. **COCO 实例 JSON**：每个 `kind==='instance'` 未隐藏 region 一条；`segmentation` 用**未压缩 RLE
   且按 COCO 约定的列主序（Fortran）**；`bbox/area` 由掩膜算；`category_id` 来自 `classes`+1。
   **JSON 必须紧凑输出**（不要 `null,2`，否则 counts 体积 ×4）。单图 + 合并两版。
3. **实例掩膜 PNG**：批量到目录 `<baseName>/indexmap.png` + `<baseName>/0001_<class>.png`…
   + `instances.json`；用 `save_file_base64` 的子目录能力。**单图「另存为」只能出 `indexmap.png`**。
4. **U-Net mask**：`mapFn = region => classes.indexOf(className)+1`（沿用现有 1-based 约定）。

全部返回 `{filename, dataUrl}` 走现有写盘命令，并**检查返回值**（`tauriInvoke` 吞异常）。
文件名一律 `baseNameOf()` + `usedNames` 去重（同名图加 `-2`）。

---

## 7. 工程保存 / 加载 / 撤销

- **保存**：`buildProjectFile()` 写 `masks[name] = { width, height, counts: <逗号串>, regions }`。
  **绝不把 masks 写进 localStorage**（5 MB 上限），分割模式需明确提示「掩膜只随工程文件保存」。
- **加载**：`loadProjectFromFile()` 逐图写入 `maskStore`（只存 counts+regions，懒解码）；
  `workMode==='segmentation'` 复用现有恢复路径（`project.svelte.ts:164-168` 已通用）。
  旧工程无 `masks` → 空掩膜，正常进分割模式。
- **撤销**：**不复用 `HistoryEntry`**。`pushHistory()` 去重是整条 `JSON.stringify` 比较
  （`state.svelte.ts:372`），塞入两万数字会每次操作大 stringify。改用 `maskHistory.ts` 独立栈，
  快照单位 = `{ name, countsStr, regionsJson }`（字符串，可比较去重、可原样回写）。
  `maxMaskHistory=20`；Canvas 的 `undo()` 在分割模式先走这条栈。

---

## 8. 分阶段与验收

### Phase 1（一期交付）
模式入口 + 工具栏/面板 + 预置类别；后端 `mask_png`；`maskStore`；overlay 渲染；
`seg_select/seg_text/seg_point/seg_box` + 接受/丢弃/全部接受 + 类别指派 + 删除；
四套导出（单图+批量）；工程保存/加载；掩膜撤销。

**验收**：
1. 三张模式卡都能进；切回检测模式，原有标注与撤销照旧。
2. 「道路」→1 个 stuff 区域；「car」→N 实例；接受后画布出现像素级掩膜，400% 放大边缘是硬边。
3. 点像素能选中对应 region；改类别颜色/数字立即变。
4. 切图往返 A→B→A 掩膜与列表都在，不出现「底片 A、掩膜 B」。
5. 导出四格式外部校验：Cityscapes PNG 唯一值 ∈ {0..18}∪{255}；COCO 用 pycocotools `annToMask`
   还原 IoU=1.0；实例 PNG 与 `instances.json` 对得上；U-Net PNG 值为 `classes` 索引。
6. 存工程 → 重启 exe → 重开工程，掩膜/类别/Cityscapes 映射/overlay 设置全还原；旧检测工程不报错。
7. Ctrl+Z 撤到进分割模式前 → 掩膜回初始（非空白、非残留一半）。
8. `npm run build` + `npm run tauri build` + 启动冒烟通过。

### Phase 2（效率与质量）
画笔/橡皮（stuff 快涂、挖洞）、mask 级候选预览、多点多框提示、批量 PCS 分割整目录（规避 5 张 state 缓存）、
前端 `imageKey→image_id` LRU（省切图重 embed）、最小面积过滤 / 重叠检测 / 小孤岛清理。

### Phase 3（规模与训练对接）
counts base64-varint 压缩；可选「PNG 索引图」存储；Cityscapes 官方调色板 PNG + trainId 映射编辑 UI；
「严格模式」每实例独立位图；mask↔polygon 互转；IndexedDB 掩膜兜底。

---

## 9. 风险与坑（务必先看）

1. **工程体积**：counts 串 100~200 KB/图 → 100 图 10~20 MB；**绝不能把 counts 落成数组**。
2. **localStorage 装不下掩膜** → masks 只进工程文件；需要掩膜专属脏标记 `ui.maskDirty`。
3. **内存**：解码图 2 MB、overlay 8.3 MB（各只留 1~2 张）。**别在 `$state` 里放大数组**（深代理开销）。
4. **SAM3 `state_cache` 只留 5 张** + 切图 `clearSamCache()` → 分割模式来回切图每张重 embed（1~2 s）。
   Phase 1 接受，Phase 2 加前端 LRU。
5. **传输体积**：必须「一张索引图 PNG」，不能每实例一张。
6. **Cityscapes 映射**：`labelId ≠ trainId`；未映射必须写 255，写 0 会被当 road。面板要列出「未映射类别」。
7. **重叠语义**：单索引图重叠像素由后接受者覆盖，COCO 会丢被遮挡实例的像素；文档写明，Phase 3 提供严格模式。
8. **PNG 往返保真**：传输解码只在「接受候选」时发生、不落盘，绕开色彩管理不确定性。
9. **`pushHistory` 去重陷阱**：掩膜绝不进 `ImageSnapshot`；分割模式 `annotations` 恒空，别误用 `pushHistory()`。
10. **`imageLoading` 期间 overlay 必须一起跳过**（陷阱 #5 同类）。
11. **导出枚举**：`getExportData()` 在 `anns.length===0` 返回 `null`；批量枚举要用 `getImagesWithMasks()`。
12. **sidecar 部署断层**：exe 只从 `<exe目录>/sidecar/sam_server.py` 起后端，而该目录目前不存在
    → 后端改动**只有手动启仓库文件才生效**。建议一期在 `tauri.conf.json` 加 `bundle.resources`，
    并修正交接文档 §2 里失效的启动路径。
13. **overlay 必须 `imageSmoothingEnabled=false`**，否则边缘混出假颜色。
14. **`name` 带子目录**：导出用 `baseNameOf()` + `usedNames` 去重。
15. **ordinal 与 region 严格一一对应**：删除后必须 `repack`，否则导出出现「值存在但 region 已删」。

---

## 10. 端到端验证方式

```powershell
cd "D:\桌面\图像标注\annotator-pro"
npm run dev                 # 浏览器里先验 UI/交互（掩膜解码、overlay、面板）
# AI 功能需先手动起后端（注意：用仓库里的文件，不是交接文档里那条失效路径）
npm run build; npm run tauri build   # 出成品 → D:\anntarget\release\annotator-pro.exe
```

- 导出物用 Python 校验：`PIL` 读 Cityscapes/U-Net PNG 的取值集合；`pycocotools.COCO.annToMask` 比对 IoU。
- 工程往返：存 `.annotator` → 重启 exe → 重开，逐项核对；再打开一个**旧检测工程**确认不报错。
- 回归：切回检测/分类模式，跑一次原有批量改类别 + `Ctrl+Z`，确认未受影响。
