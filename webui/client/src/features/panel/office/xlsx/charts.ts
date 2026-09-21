/**
 * xlsx 内嵌图表：解析 xl/charts/chartN.xml 为与渲染库无关的描述，再转成 echarts 配置。
 * 只还原「看得懂这张图」所需的部分：类型、标题、图例、系列名 / 分类 / 数值、堆叠（含百分比堆叠）与方向、
 * 次坐标轴、复合饼图的拆分、显式指定的系列颜色。不还原坐标轴的细节格式、数据标签样式等。
 */

export type SeriesType = 'line' | 'bar' | 'area' | 'pie' | 'scatter';
export interface ChartSeries {
  type: SeriesType; name: string; cats: string[]; vals: Array<number | null>;
  /** 散点图的 x 值 */
  xs?: Array<number | null>;
  /** 显式指定的系列颜色；没有则按主题色轮换 */
  color?: string;
  /** 数值的数字格式（如 #,##0.00）：数据标签显式指定的优先，否则取数值缓存里记的源单元格格式 */
  fmt?: string;
  /** 缓存值缺失时（openpyxl 等不写缓存）回工作表取数用的引用，如 汇总分析!$B$4:$G$4 */
  nameRef?: string; catRef?: string; valRef?: string; xRef?: string;
  /** 画在次坐标轴上（组合图里量级不同的系列，如金额柱 + 增长率线） */
  secondary?: boolean;
}
export interface ChartSpec {
  title?: string;
  series: ChartSeries[];
  /** 条形图（横向） */
  horizontal?: boolean;
  stacked?: boolean;
  /** 百分比堆叠：每个分类内归一到 100% */
  percent?: boolean;
  doughnut?: boolean;
  /** 复合饼图：末尾若干点拆到第二个小饼里，主饼上合并成一块「其他」 */
  split?: { type: string; pos?: number };
  /** 图例位置：r / l / t / b / tr；没有图例为空 */
  legend?: string;
  /** 数据标签：饼图常用的百分比 / 数值 / 分类名 */
  labels?: { percent?: boolean; value?: boolean; name?: boolean };
  /** 主题强调色（accent1-6），由调用方按工作簿主题填入 */
  palette?: string[];
}

const TYPE_OF: Record<string, SeriesType> = {
  lineChart: 'line', line3DChart: 'line', barChart: 'bar', bar3DChart: 'bar', areaChart: 'area', area3DChart: 'area',
  pieChart: 'pie', pie3DChart: 'pie', doughnutChart: 'pie', ofPieChart: 'pie', scatterChart: 'scatter',
};

const elems = (el: Element | undefined | null) => (el ? Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1) : []);
const kids = (el: Element | undefined | null, name: string) => elems(el).filter(c => c.localName === name);
const kid = (el: Element | undefined | null, name: string) => kids(el, name)[0];
const val = (el: Element | undefined | null, name: string) => kid(el, name)?.getAttribute('val') ?? undefined;
const on = (el: Element | undefined | null, name: string) => { const v = val(el, name); return v === '1' || v === 'true'; };

/** 引用块（strRef / numRef）：取公式与缓存点；缓存按 idx 落位，缺的留空 */
function readRef(holder: Element | undefined): { f?: string; pts: string[]; fmt?: string } {
  const ref = holder && (kid(holder, 'strRef') || kid(holder, 'numRef') || kid(holder, 'multiLvlStrRef'));
  if (!ref) {
    // 字面量：直接写死的 <c:v> 或 numLit / strLit
    const lit = holder && (kid(holder, 'numLit') || kid(holder, 'strLit'));
    const v = holder && kid(holder, 'v')?.textContent;
    return { pts: lit ? readPts(lit) : v ? [v] : [] };
  }
  const cache = kid(ref, 'strCache') || kid(ref, 'numCache') || kid(kid(ref, 'multiLvlStrCache'), 'lvl');
  return { f: kid(ref, 'f')?.textContent || undefined, pts: cache ? readPts(cache) : [], fmt: kid(cache, 'formatCode')?.textContent || undefined };
}
/** 数据标签显式指定的数字格式（sourceLinked=1 表示跟随源单元格，不算显式） */
function labelFmt(dLbls: Element | undefined): string | undefined {
  const nf = kid(dLbls, 'numFmt');
  return nf && nf.getAttribute('sourceLinked') !== '1' ? nf.getAttribute('formatCode') || undefined : undefined;
}
function readPts(cache: Element): string[] {
  const out: string[] = [];
  for (const pt of kids(cache, 'pt')) out[Number(pt.getAttribute('idx') || out.length)] = kid(pt, 'v')?.textContent || '';
  return Array.from(out, v => v ?? '');
}
const toNum = (s: string | undefined) => (s == null || s === '' || isNaN(Number(s)) ? null : Number(s));

/** 系列显式颜色：只认直接给出的 srgbClr（线条类在 ln 下，填充类直接在 spPr 下） */
function readColor(ser: Element, line: boolean): string | undefined {
  const spPr = kid(ser, 'spPr');
  const fill = kid(line ? kid(spPr, 'ln') : spPr, 'solidFill');
  const rgb = kid(fill, 'srgbClr')?.getAttribute('val');
  return rgb ? `#${rgb}` : undefined;
}

export function parseChart(xml: string): ChartSpec | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const chart = kid(doc.documentElement, 'chart');
  const plot = kid(chart, 'plotArea');
  if (!chart || !plot) return null;
  const spec: ChartSpec = { series: [] };
  // 次坐标轴：数值轴里 crosses=max（贴在对侧）的那根。不能按「第二根数值轴」判断——散点 / 气泡图的 x、y 本来就是两根数值轴
  const secondaryIds = new Set(kids(plot, 'valAx').filter(ax => val(ax, 'crosses') === 'max').map(ax => val(ax, 'axId')).filter(Boolean));
  // 组合图：plotArea 下可以有多个 xxxChart，各自的系列带各自的类型
  for (const group of elems(plot)) {
    const type = TYPE_OF[group.localName];
    if (!type) continue;
    if (group.localName === 'doughnutChart') spec.doughnut = true;
    if (group.localName === 'ofPieChart') spec.split = { type: val(group, 'splitType') || 'auto', pos: toNum(val(group, 'splitPos')) ?? undefined };
    if (type === 'bar' && val(group, 'barDir') === 'bar') spec.horizontal = true;
    const grouping = val(group, 'grouping') || '';
    if (/stacked/i.test(grouping)) spec.stacked = true;
    if (grouping === 'percentStacked') spec.percent = true;
    const secondary = type !== 'scatter' && kids(group, 'axId').some(a => secondaryIds.has(a.getAttribute('val') ?? undefined));
    const dl = kid(group, 'dLbls');
    if (dl && (on(dl, 'showPercent') || on(dl, 'showVal') || on(dl, 'showCatName'))) spec.labels = { percent: on(dl, 'showPercent'), value: on(dl, 'showVal'), name: on(dl, 'showCatName') };
    for (const ser of kids(group, 'ser')) {
      const name = readRef(kid(ser, 'tx')), cat = readRef(kid(ser, type === 'scatter' ? 'xVal' : 'cat')), v = readRef(kid(ser, type === 'scatter' ? 'yVal' : 'val'));
      const s: ChartSeries = { type, name: name.pts[0] || '', nameRef: name.f, cats: cat.pts, catRef: cat.f, vals: v.pts.map(toNum), valRef: v.f, color: readColor(ser, type === 'line' || type === 'scatter') };
      if (type === 'scatter') { s.xs = cat.pts.map(toNum); s.xRef = cat.f; s.cats = []; s.catRef = undefined; }
      if (secondary) s.secondary = true;
      const sdl = kid(ser, 'dLbls');
      s.fmt = labelFmt(sdl) || labelFmt(dl) || v.fmt;
      if (!spec.labels && sdl && (on(sdl, 'showPercent') || on(sdl, 'showVal') || on(sdl, 'showCatName'))) spec.labels = { percent: on(sdl, 'showPercent'), value: on(sdl, 'showVal'), name: on(sdl, 'showCatName') };
      spec.series.push(s);
    }
  }
  if (!spec.series.length) return null;
  // 标题只取 chart 直属的那个（坐标轴标题在 plotArea 里）；富文本各 run 拼起来
  const title = kid(chart, 'title');
  const runs = title ? Array.from(title.getElementsByTagNameNS('*', 't')).map(n => n.textContent || '').join('') : '';
  if (runs) spec.title = runs;
  const legend = kid(chart, 'legend');
  if (legend) spec.legend = val(legend, 'legendPos') || 'r';
  return spec;
}

/** 缓存值缺失的系列回工作表取数；lookup 按引用返回展平后的单元格值，formatOf 返回引用区域首格的数字格式 */
export function fillFromSheet(spec: ChartSpec, lookup: (ref: string) => unknown[], formatOf?: (ref: string) => string | undefined) {
  const text = (v: unknown) => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
  const num = (v: unknown) => (typeof v === 'number' ? v : toNum(text(v)));
  for (const s of spec.series) {
    if (!s.name && s.nameRef) s.name = text(lookup(s.nameRef)[0]);
    if (!s.cats.length && s.catRef) s.cats = lookup(s.catRef).map(text);
    if (!s.vals.length && s.valRef) s.vals = lookup(s.valRef).map(num);
    if (s.xs && !s.xs.length && s.xRef) s.xs = lookup(s.xRef).map(num);
    if (!s.fmt && s.valRef) s.fmt = formatOf?.(s.valRef);
  }
}

/** 解析区域引用：'Sheet 1'!$B$4:$G$4 → 表名 + 0 基行列范围；不是单个矩形区域返回 null */
export function parseRangeRef(ref: string): { sheet: string; r1: number; c1: number; r2: number; c2: number } | null {
  const m = ref.replace(/^\(|\)$/g, '').match(/^(?:'((?:[^']|'')+)'|([^'!]+))!\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/);
  if (!m) return null;
  const col = (s: string) => s.toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const c1 = col(m[3]), r1 = Number(m[4]) - 1;
  return { sheet: (m[1] || m[2]).replace(/''/g, "'"), r1, c1, r2: m[6] ? Number(m[6]) - 1 : r1, c2: m[5] ? col(m[5]) : c1 };
}

// ---------- → echarts ----------

const DEFAULT_PALETTE = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'];
const LEGEND_POS: Record<string, object> = {
  r: { orient: 'vertical', right: 8, top: 'middle' }, tr: { orient: 'vertical', right: 8, top: 8 },
  l: { orient: 'vertical', left: 8, top: 'middle' }, t: { top: 28 }, b: { bottom: 6 },
};

/** 图例文字的大致宽度（11px 字号：CJK 按整字、其余按半字），用来给侧边图例让出位置 */
function legendWidth(names: string[]): number {
  let max = 0;
  for (const n of names) { let w = 0; for (let i = 0; i < n.length; i++) w += n.charCodeAt(i) > 0x2E7F ? 11 : 6.2; if (w > max) max = w; }
  return Math.min(160, Math.ceil(max) + 38);
}

/** format：按数字格式码输出数值文本（调用方接 numfmt；不传则原样输出）；otherLabel：复合饼图主饼上合并块的名字 */
export function toEChartsOption(spec: ChartSpec, format: (v: number, code?: string) => string = String, otherLabel = 'Other'): Record<string, unknown> {
  const first = spec.series[0];
  const pie = first.type === 'pie', scatter = first.type === 'scatter';
  const num = (v: unknown, code?: string) => (typeof v === 'number' ? format(v, code) : v == null ? '' : String(v));
  // 图例占掉的边：侧边图例按文字宽度估，绘图区（饼图的布局区 / 直角坐标的 grid）从这里开始让
  const sideW = legendWidth(pie ? first.cats : spec.series.map(s => s.name));
  const inset = {
    top: (spec.title ? 30 : 8) + (spec.legend === 't' ? 22 : 0), bottom: spec.legend === 'b' ? 30 : 8,
    left: spec.legend === 'l' ? sideW : 8, right: spec.legend === 'r' || spec.legend === 'tr' ? sideW : 8,
  };
  const base = {
    animation: false, // 静态预览；也避免每次缩放重设尺寸时重播入场动画
    color: spec.palette?.length ? spec.palette : DEFAULT_PALETTE,
    textStyle: { fontFamily: 'inherit' },
    title: spec.title ? { text: spec.title, left: 'center', top: 6, textStyle: { fontSize: 13, fontWeight: 'normal' } } : undefined,
    legend: spec.legend ? { type: 'scroll', itemWidth: 14, itemHeight: 8, textStyle: { fontSize: 11 }, ...LEGEND_POS[spec.legend] } : undefined,
    tooltip: { trigger: pie || scatter ? 'item' : 'axis', confine: true, valueFormatter: (v: unknown) => num(v, first.fmt) },
  };
  if (pie) {
    // 饼图只画第一个系列（Excel 也是如此）
    const s = first;
    const lb = spec.labels;
    // 标签分两行（分类名 / 数值 百分比）压窄宽度；数值套数字格式，百分比按 Excel 的默认取整
    const fmt = lb && ((p: { name: string; value: number; percent: number }) => {
      const tail = [lb.value && num(p.value, s.fmt), lb.percent && `${Math.round(p.percent)}%`].filter(Boolean).join(' ');
      return [lb.name && p.name, tail].filter(Boolean).join('\n');
    });
    const label = fmt ? { formatter: fmt, fontSize: 11, lineHeight: 14 } : { show: false };
    const labelLine = { show: !!fmt, length: 8, length2: 8 };
    // 颜色按数据点的原始序号定死：复合饼图拆成两个饼后，各自从调色板头部取色会撞色，图例也对不上
    // 点数超过调色板时，每多一轮向白色提亮一档（Excel 也是同色系变化亮度），避免与第一轮撞色
    const colorAt = (i: number) => {
      const hex = base.color[i % base.color.length], round = Math.floor(i / base.color.length);
      if (!round || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
      const k = Math.min(0.75, round * 0.4);
      return `#${[1, 3, 5].map(p => Math.round(parseInt(hex.slice(p, p + 2), 16) * (1 - k) + 255 * k).toString(16).padStart(2, '0')).join('')}`;
    };
    const pts = s.vals.map((v, i) => ({ name: s.cats[i] ?? String(i + 1), value: v, itemStyle: { color: colorAt(i) } }));
    // 复合饼图：按拆分规则把一部分点挪进第二个小饼，主饼上用「其他」一块代替它们
    let second: typeof pts = [];
    if (spec.split && pts.length > 2) {
      const { type, pos } = spec.split;
      const total = pts.reduce((n, p) => n + (p.value || 0), 0) || 1;
      // 按位置拆：末尾 pos 个；没给个数时 Excel 默认取末尾三分之一
      const tail = type === 'pos' && pos ? pos : Math.ceil(pts.length / 3);
      second = pts.filter((p, i) => (type === 'percent' && pos != null ? (p.value || 0) / total * 100 < pos : type === 'val' && pos != null ? (p.value || 0) < pos : i >= pts.length - tail));
      if (second.length === pts.length) second = [];
    }
    if (second.length) {
      const main = [...pts.filter(p => !second.includes(p)), { name: otherLabel, value: second.reduce((n, p) => n + (p.value || 0), 0), itemStyle: { color: colorAt(pts.length) } }];
      return {
        ...base,
        // 图例项的颜色显式给：两个饼各有一套数据，让图例自己推断会取错
        legend: base.legend && { ...base.legend, data: [...main, ...second].map(p => ({ name: p.name, itemStyle: p.itemStyle })) },
        series: [
          { type: 'pie', name: s.name, ...inset, center: ['32%', '50%'], radius: fmt ? '36%' : '46%', data: main, label, labelLine },
          { type: 'pie', name: otherLabel, ...inset, center: ['78%', '50%'], radius: fmt ? '20%' : '26%', data: second, label, labelLine },
        ],
      };
    }
    const outer = fmt ? '50%' : '72%';
    return {
      ...base,
      // 给饼图单独划布局区：标签只在区内排布，不会压到图例和标题上
      series: [{ type: 'pie', name: s.name, ...inset, center: ['50%', '50%'], radius: spec.doughnut ? ['28%', outer] : outer, data: pts, label, labelLine }],
    };
  }
  const grid = { containLabel: true, ...inset, top: inset.top + 10, left: inset.left + 4, right: inset.right + 8 };
  const axisLabel = { fontSize: 11 };
  if (scatter) {
    return {
      ...base, grid, xAxis: { type: 'value', axisLabel, scale: true }, yAxis: { type: 'value', axisLabel, scale: true },
      series: spec.series.map(s => ({ type: 'scatter', name: s.name, symbolSize: 7, itemStyle: s.color ? { color: s.color } : undefined, data: s.vals.map((y, i) => [s.xs?.[i] ?? i + 1, y]) })),
    };
  }
  const cats = spec.series.find(s => s.cats.length)?.cats ?? spec.series[0].vals.map((_, i) => String(i + 1));
  const catAxis = { type: 'category', data: cats, axisLabel, axisTick: { alignWithLabel: true }, inverse: !!spec.horizontal };
  // 次坐标轴只在「确实有两组系列」时才画；全部系列都挂在对侧轴上的，当普通单轴处理
  const dual = spec.series.some(s => s.secondary) && spec.series.some(s => !s.secondary);
  const onSecond = (s: ChartSeries) => dual && !!s.secondary;
  // 百分比堆叠：主轴上的系列在每个分类内归一到 100%
  const totals = spec.percent ? cats.map((_, i) => spec.series.reduce((n, s) => n + (onSecond(s) ? 0 : Math.abs(s.vals[i] || 0)), 0)) : null;
  const pct = (v: unknown) => (typeof v === 'number' ? `${Math.round(v * 10) / 10}%` : '');
  const valAxis = totals ? { type: 'value', max: 100, axisLabel: { ...axisLabel, formatter: '{value}%' } } : { type: 'value', axisLabel };
  // 次轴的网格线不画（两根轴刻度不对齐，画出来是两套错开的横线）；数值格式跟该轴上的系列走（如增长率的百分比）
  const secondFmt = spec.series.find(onSecond)?.fmt;
  const secondAxis = { type: 'value', axisLabel: { ...axisLabel, formatter: (v: number) => num(v, secondFmt) }, position: spec.horizontal ? 'top' : 'right', splitLine: { show: false } };
  const valAxes = dual ? [valAxis, secondAxis] : valAxis;
  return {
    ...base, grid,
    tooltip: { ...base.tooltip, valueFormatter: totals ? pct : base.tooltip.valueFormatter },
    xAxis: spec.horizontal ? valAxes : catAxis, yAxis: spec.horizontal ? catAxis : valAxes,
    series: spec.series.map(s => ({
      type: s.type === 'bar' ? 'bar' : 'line', name: s.name,
      data: totals && !onSecond(s) ? s.vals.map((v, i) => (v == null || !totals[i] ? v : v / totals[i] * 100)) : s.vals,
      ...(onSecond(s) ? (spec.horizontal ? { xAxisIndex: 1 } : { yAxisIndex: 1 }) : {}),
      // 提示里的数值按各系列自己的格式（金额与增长率同图时不能共用一个）
      tooltip: { valueFormatter: (v: unknown) => (totals && !onSecond(s) ? pct(v) : num(v, s.fmt)) },
      stack: spec.stacked && !onSecond(s) ? (s.type === 'bar' ? 'bar' : 'line') : undefined,
      areaStyle: s.type === 'area' ? { opacity: 0.6 } : undefined,
      symbolSize: 5, lineStyle: s.color && s.type !== 'bar' ? { color: s.color } : undefined, itemStyle: s.color ? { color: s.color } : undefined,
      label: spec.labels?.value ? { show: true, fontSize: 10, position: spec.horizontal ? 'right' : 'top', formatter: (p: { value: unknown }) => (totals && !onSecond(s) ? pct(p.value) : num(p.value, s.fmt)) } : undefined,
    })),
  };
}
