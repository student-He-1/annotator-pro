/** 索引图的行程编码（RLE）与区域几何工具。
 *
 *  ## 为什么形态和方案里写的不完全一样
 *
 *  方案 §4 写的是「counts 交替 [背景长, k长, 背景长, k长, ...]」，靠奇偶位置判断
 *  这一段是背景还是某个 region。这个约定在**两个不同区域像素相邻**时必然崩：
 *  SAM 经常把贴在一起的两辆车分成两个实例，索引图里就是 ...1,1,2,2...
 *  按行程编码得到「k=1 长 N、k=2 长 M」两个非零行程紧挨着，
 *  解码端按奇偶还原会把 k=2 当成背景，掩膜凭空少一半。
 *
 *  所以这里多带一路 `ids`：counts[i] 是第 i 个行程的**长度**，ids[i] 是这个行程的**值**
 *  （0 = 背景，k = ordinal）。解码按顺序铺，不存在「靠位置猜值」。
 *  两路都是短数组 —— 一张图千把个行程也就几千个数字，工程文件里落成逗号串。
 */

export interface RunEncoded { counts: number[]; ids: number[] }

/** 索引图 → 行程编码 */
export function encodeRuns(map: Uint8Array): RunEncoded {
  const counts: number[] = [];
  const ids: number[] = [];
  if (map.length === 0) return { counts, ids };

  let prev = map[0];
  let run = 1;
  for (let i = 1; i < map.length; i++) {
    const v = map[i];
    if (v === prev) { run++; continue; }
    counts.push(run);
    ids.push(prev);
    prev = v;
    run = 1;
  }
  counts.push(run);
  ids.push(prev);
  return { counts, ids };
}

/** 行程编码 → 索引图。length 必须等于 width*height，短了按背景补齐。 */
export function decodeRuns(counts: number[], ids: number[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  const n = Math.min(counts.length, ids.length);
  let p = 0;
  for (let i = 0; i < n && p < length; i++) {
    const len = counts[i];
    if (!(len > 0)) continue;
    const end = Math.min(length, p + len);
    const v = ids[i];
    if (v) out.fill(v, p, end);
    p = end;
  }
  return out;
}

/** 逗号串 → 数组。工程文件里的 counts/ids 只存这个形态（绝不落 JSON 数组）。 */
export function parseRunString(s: string | undefined | null): number[] {
  if (!s) return [];
  return s.split(',').map(v => parseInt(v, 10)).filter(v => Number.isFinite(v));
}

export function runStringOf(arr: number[]): string {
  return arr.join(',');
}

/** 某个 ordinal 的像素数与包围盒（接受区域时算一次，导出也用它） */
export function regionStats(map: Uint8Array, width: number, ordinal: number): {
  area: number;
  box: { x1: number; y1: number; x2: number; y2: number } | undefined;
} {
  let area = 0;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let i = 0; i < map.length; i++) {
    if (map[i] !== ordinal) continue;
    area++;
    const y = (i / width) | 0;
    const x = i - y * width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (area === 0) return { area: 0, box: undefined };
  return { area, box: { x1: minX, y1: minY, x2: maxX + 1, y2: maxY + 1 } };
}

/** 把 src 里值等于 srcValue 的像素写进 dst，dst 里写入的值是 dstValue。返回写入像素数。 */
export function mergeRun(src: Uint8Array, srcValue: number, dst: Uint8Array, dstValue: number): number {
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === srcValue) { dst[i] = dstValue; n++; }
  }
  return n;
}

/** 删除某个 ordinal 的像素（置 0），并把它之后的所有 ordinal 递减 1。
 *  ordinal 与 regions 下标必须严格一一对应，删了不 repack 就会出现
 *  「索引图里有值、regions 里没这个区域」→ 导出时越界 / 渲染时漏色。 */
export function removeOrdinalInPlace(map: Uint8Array, ordinal: number) {
  for (let i = 0; i < map.length; i++) {
    const v = map[i];
    if (v === ordinal) map[i] = 0;
    else if (v > ordinal) map[i] = v - 1;
  }
}

/** COCO 用的 RLE：**列主序**（Fortran order）的二值行程，counts 第一项是开头连续 0 的个数。
 *
 *  这是整套导出里最容易写出「看起来对、其实转了置」的地方，所以单独抽出来做单元校验：
 *  用 pycocotools 的 decode 反向还原，和原始掩膜逐像素比较（方案 §7 的验收要求）。
 *  注意别用「转置整个 200 万像素数组」的实现 —— 又慢又容易把 x/y 写反。
 */
export function rleBinaryColMajor(map: Uint8Array, width: number, height: number, ordinal: number): number[] {
  const counts: number[] = [];
  let prev = 0;
  let run = 0;
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const v = map[y * width + x] === ordinal ? 1 : 0;
      if (v === prev) { run++; continue; }
      counts.push(run);
      run = 1;
      prev = v;
    }
  }
  counts.push(run);
  return counts;
}
