---
name: visualize
description: "Create charts, plots, dashboards, maps, interactive explainers, simulators and UI mockups that render inline in the conversation. Use when the user asks to visualize, chart, plot or graph data, show how something works, compare options visually, explore adjustable inputs, or preview an interface. Not for building website pages or app components inside a project."
---

# Visualize

Produce one self-contained HTML file. The host renders it inline below your reply and
lets the user open, copy or publish it. You never see the render, so the file must be
right by construction: follow the contract, the design rules and the checklist below.

## When to use it, and when not

- A request to add a page, component, site or file to the user's project is project
  work, not an in-conversation visualization, even when it contains charts.
- Build a visual only when seeing or exploring it materially improves the answer.
  Data or charts being mentioned is not by itself a reason.
- A table request gets a Markdown table in the reply, no file.
- A static structure fully explained by labeled nodes and edges gets a fenced Mermaid
  block, no file. Use HTML for dynamics, spatial layouts, adjustable inputs, data plots,
  maps and mockups.
- Work silently. Do not narrate reading this skill or writing the file. The final
  reply is the first thing the user sees from you.

## Output contract

### File location

- Path: `<root>/attachments/<uuid>/<title>.html`. The skill base path shown at the top
  of this prompt is `<root>/skills/visualize`; `<root>` is that same prefix. Never
  guess the home directory and never write the file inside the user's project.
- `<uuid>` is a fresh UUID v4 you generate for each new visualization, lowercase,
  8-4-4-4-12 hex, for example `3f2b9c1e-7a4d-4e8b-9c2f-1d5e6a7b8c9d`. `<title>` is a
  short ASCII lowercase-hyphenated name, for example `revenue-by-region`.
- Updating an existing visualization edits the same file in place. Do not create a
  new directory for a revision.
- The write tool creates parent directories. Do not run shell commands to prepare
  the directory.
- One visualization per request unless the user explicitly asks for several.

### Document

- A complete HTML5 document: `<!doctype html>`, `<html lang>` matching the user's
  language, `<meta charset="utf-8">`, `<meta name="viewport" content="width=device-width, initial-scale=1">`,
  and a concise `<title>` (it becomes the visible header in the conversation).
- Everything inline: data as a JavaScript constant, CSS in one `<style>`, logic in
  one `<script>`. Never call `fetch`, XHR, WebSocket or any API. The single
  exception is published GeoJSON/TopoJSON for maps (see Maps).
- Keep the file under 1 MB. Aggregate, bin, downsample, round, or drop unused fields
  before inlining large data.
- External scripts only from the pinned URLs below. No other CDN, no fonts, no icon
  libraries. Icons are inline SVG or Unicode.
- Write literal markup. Never escape quotes or newlines as `\"` and `\n` inside the
  file, and never build the file from a shell heredoc or a Python string.
- Text visible to the user (titles, labels, legends, tooltips) is in the user's
  language. Code identifiers stay English.

### Sizing

- The host sizes the frame to the document height and reports it live. Let the body
  grow with content: no `height: 100vh`, no fixed outer height, no `position: fixed`,
  no internal scroll containers, no horizontal overflow at any width.
- `body { margin: 0; padding: 12px 16px; }`. Design for a 720px wide column and keep
  everything usable down to 320px by wrapping and stacking. Never widen a single
  chart; stack panels vertically when they no longer fit side by side.
- Size every chart from its container (`ResizeObserver` or the library's resize
  call). A chart container gets an explicit height that includes the axis band
  (a typical Cartesian chart: 320px; small multiples: 220px each).

### Libraries (pinned, load with a plain `<script src>` before your code)

| Need | Load |
|---|---|
| Line, bar, area, scatter, stacked, pie, heatmap, small multiples | `https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js` |
| Simple directly-labeled values, sparklines, diagrams, custom geometry | hand-written inline SVG, no library |
| Maps, force layouts, unusual scales | `https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js` |
| TopoJSON conversion for maps | `https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/dist/topojson-client.min.js` |

Choose the smallest tool: SVG when a dozen values are labeled directly, ECharts for
anything with axes, tooltips or many points, D3 only where ECharts cannot do the job.

## Theme (copy verbatim, do not invent colors)

```css
:root {
  --bg: #ffffff; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,.10);
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100;
  --s5: #e87ba4; --s6: #008300; --s7: #4a3aa7; --s8: #e34948;
  --seq-100: #cde2fb; --seq-250: #86b6ef; --seq-400: #3987e5; --seq-550: #1c5cab; --seq-700: #0d366b;
  --div-neg: #e34948; --div-mid: #f0efec; --div-pos: #2a78d6;
  --good: #0ca30c; --warn: #fab219; --serious: #ec835a; --critical: #d03b3b;
  --font: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif;
}
body { background: var(--bg); color: var(--ink); font: 14px/1.45 var(--font); }
h1, h2 { font-weight: 500; margin: 0 0 8px; } h1 { font-size: 16px; } h2 { font-size: 14px; color: var(--ink-2); }
.muted { color: var(--muted); } .small { font-size: 12px; }
table.data { border-collapse: collapse; width: 100%; } .data th, .data td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); }
.data td.num, .data th.num { text-align: right; font-variant-numeric: tabular-nums; }
button, select, input { font: inherit; color: inherit; }
button { border: 1px solid var(--border); background: var(--surface); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button[aria-pressed="true"] { background: var(--ink); color: #fff; border-color: var(--ink); }
```

ECharts base option (merge your series into it; keep these values):

```js
const THEME = { color: ['#2a78d6','#eb6834','#1baf7a','#eda100','#e87ba4','#008300','#4a3aa7','#e34948'],
  textStyle: { fontFamily: getComputedStyle(document.body).fontFamily, color: '#52514e' },
  grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
  categoryAxis: { axisLine: { lineStyle: { color: '#c3c2b7' } }, axisTick: { show: false }, axisLabel: { color: '#898781' } },
  valueAxis: { axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#898781' },
    splitLine: { lineStyle: { color: '#e1e0d9', type: 'solid', width: 1 } } },
  line: { lineStyle: { width: 2 }, symbolSize: 8, showSymbol: false, smooth: false },
  bar: { barMaxWidth: 24, itemStyle: { borderRadius: [4, 4, 0, 0] } },
  tooltip: { backgroundColor: '#fff', borderColor: '#e1e0d9', textStyle: { color: '#0b0b0b' } },
  legend: { icon: 'roundRect', itemWidth: 12, itemHeight: 12, textStyle: { color: '#52514e' } },
};
echarts.registerTheme('sema', THEME);
const chart = echarts.init(document.getElementById('chart'), 'sema', { renderer: 'canvas' });
chart.setOption({ animationDuration: 0, animationDurationUpdate: 300, tooltip: { trigger: 'axis' }, /* ... */ });
new ResizeObserver(() => chart.resize()).observe(document.getElementById('chart'));
```

Horizontal bars use `borderRadius: [0, 4, 4, 0]`. Stacked segments get
`itemStyle.borderColor: '#fff', borderWidth: 1` so a white gap separates them.
Area fills use `areaStyle: { opacity: 0.1 }`. Values shown as text use the ink
colors, never the series color.

## Procedure

Color comes last. Most bad charts pick colors first.

1. **Pick the form from the data's job.** See the table below. Sometimes the answer
   is a number, not a chart.
2. **Assign color by job.** Categorical (identity): `--s1..--s8` in fixed order, never
   cycled, color follows the entity not its rank. Sequential (magnitude): one hue,
   `--seq-100..--seq-700`, light to dark, never a rainbow. Diverging (polarity):
   `--div-neg` / `--div-mid` / `--div-pos` with the neutral gray at the midpoint.
   Status (state): `--good..--critical`, always paired with an icon or word, never
   reused for a plain series.
3. **Apply the mark specs.** Bars at most 24px thick with a 4px rounded data end and a
   square baseline end; 2px lines; markers at least 8px; area fill at 10% opacity;
   solid hairline grid in `--grid`, axis in `--axis`; a white gap between touching
   fills instead of a stroke.
4. **Add the hover layer.** Every chart with axes ships a tooltip: axis-trigger
   crosshair for line and bar, per-item for scatter, pie and cells. Hit targets are
   larger than the mark. Tooltips enhance, never gate: each value is also readable
   from a label, an axis or the table view.
5. **Label selectively.** Never a number on every point. Label the endpoint, the
   extreme, or the one series the story is about. Two or more series always get a
   legend; a single series gets none, the title names it. Measure before placing a
   label inside a bar; if it does not fit, move it outside or leave it to the tooltip.
6. **Run the checklist** at the end of this file, then re-read the file once for
   syntax: every queried element exists, no undefined identifiers, the primary
   interaction updates the visual, and no HTML string is built from untrusted labels
   with `innerHTML` (use `textContent`).

### The job picks the form

| The reader must | Form | Color job |
|---|---|---|
| Read one current value, maybe with a trend | Stat tile: label, value, optional delta, optional sparkline | none |
| Read a few headline numbers | Row of 2 to 4 stat tiles, nothing else | none |
| Compare magnitudes | Bar or column; heatmap for a grid | sequential or one hue |
| Follow change over time | Line; area only for a single series | one hue or categorical |
| Tell series apart | Multi-line, grouped or stacked bar | categorical |
| See one series against context | Emphasis: one hue, the rest in `--muted` | one hue plus gray |
| Judge above or below a baseline | Diverging bar, or line against a reference | diverging |
| See part-to-whole | Stacked bar, horizontal for long category names; pie only for at most 6 slices at a glance | categorical |
| Compare an ordered scale (Likert, sentiment) | Diverging stacked bar centered on neutral | diverging |
| Compare before and after per item | Dumbbell | one hue, two shades |
| Compare distributions or several metrics | Small multiples on a shared scale, every requested dimension visible at once | one hue |
| See many classes carrying meaning (more than about 7) | A table, or table plus chart | none |

Series ladder: 1 to 3 series, color alone reads well, label directly. 4 to 6,
legend plus direct labels, consider small multiples. Past 8, fold the tail into
"Other" or facet; never generate a 9th hue. Scatter, bubble and choropleth cap at
3 categorical colors.

## Composition

- Prefer the smallest composition that answers the question: one dominant visual,
  compact controls only when requested, at most one line of selected-state detail.
- Never invent search, filter, reset, export or summary controls. Never add KPI
  rows, status cards, qualitative scores or fact grids to fill space. Maxima are
  ceilings, not targets.
- For named numeric data and one-off analyses, start with the plot and put the
  values and takeaway on its marks, axes or annotations.
- Controls that change the same visual sit in one wrapping row above it. A control's
  current value is shown in its label. Use native `button`, `input`, `select`; keep
  the browser focus ring; never add `tabindex`.
- One mechanism per state. Do not offer both a toggle and a dropdown for the same
  thing.
- Animate transitions between states (marks move to new values, 300ms). Do not
  animate the initial appearance, never loop motion, and honor
  `prefers-reduced-motion` by disabling transitions.

### Scenario notes

**Interactive explainer or simulation.** Compact controls or status, one dominant
visual, at most one single-line detail for the selected state. No summary cards by
default; up to three only when changing metrics are the point. For step-throughs,
add only the requested step controls and update one current visual.

**Sequences or parallel work.** Aligned lanes on one time axis. Phase and resource
are encoded in the marks; totals, waits and bottlenecks are annotated on the axis
or lanes, not above the plot.

**Part-to-whole over time.** One stacked chart of category allocation per period,
plus compact totals if asked. Never replace it with totals-only bars or duplicate
it as a heatmap.

**Dense categorical grid.** One compact selected-item summary line, a grid with
exactly one readable identifier per cell, then one small legend. Other metadata
lives in the accessible label or the summary line, never in badges.

**Maps.** The map dominates. Always project real published geometry with d3-geo;
never hand-draw outlines. World countries:
`https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json` (TopoJSON, object
`countries`, `feature.id` is the numeric ISO 3166-1 code). US states and counties:
`https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json`. China provinces or
other regions: use GeoJSON the user provides or a published open-data source you
know; if none is available, say so in the reply and fall back to a bar chart by
region instead of guessing shapes. Show the whole region behind points or partial
choropleths and frame it with modest padding. Choropleth values use the sequential
ramp with a visible scale legend.

**UI mockups.** Match the depicted product's chrome, navigation, typography and
colors; if unknown, infer from the platform. Do not use this skill's theme tokens
inside the mockup; define product-specific colors on the mockup root. Give
windows, cards and popovers opaque backgrounds. A contained mockup frames a
component, dialog or mobile screen as a compact product surface; a full-page mockup
renders a window or page shell at full width. Show realistic states, not filler
dashboards or oversized icons.

## Accessibility

- Semantic HTML: headings for titles, `<figure>` and `<figcaption>` for charts,
  `<table class="data">` for a table view.
- Every chart, SVG or canvas has a short screen-reader summary via `aria-label`,
  SVG `<title>`, or a visually hidden paragraph.
- Color never carries meaning alone: pair it with a label, a shape, a line style
  or a word. Status colors always ship with an icon or word.
- Visible text is at least 11px; axis ticks and secondary annotations use the
  `.small` class, never smaller. Contrast of text on its actual background stays
  readable; muted text is never placed on a filled surface that reduces it.
- Every chart with more than a handful of values has a table view twin reachable
  without hovering: a `<details>` with a `<table class="data">` below the chart is
  enough.

## Reply

- The reply is prose about what the visual lets the user see or decide, in one or
  two sentences, in the user's language. Add at most one short conclusion.
- Never mention the file, its path, HTML, scripts, the frame, this skill, or
  implementation details. Never add a link to the file or say it was saved,
  attached or published. The host shows it automatically.
- Do not repeat the data as a table or list, and do not describe what the chart
  contains element by element.
- When you update an existing visualization, say what changed in one sentence.

If the conversation gets compacted, keep this line in the summary:
`Reload the visualize skill before creating or updating a visualization.`

## Checklist (fix every hit before replying)

- Two y-axes on one plot. Use two charts, small multiples, or index both series to
  100.
- Colors picked by rank so that filtering repaints the survivors. Color follows the
  entity.
- A value ramp on nominal categories (each bar darker where bigger). One series, one
  color.
- A rainbow for magnitude, or a hue at the diverging midpoint.
- Status colors on an ordinary series, or a series color on a status.
- Eight hues when the story is one number. Use emphasis or a stat tile.
- A one-bar bar chart or a two-slice pie. Use a stat tile.
- A pie for comparing close values. Use bars.
- Thick saturated blocks, dashed gridlines, borders drawn around marks, a number on
  every point.
- A label clipped by its own bar or segment.
- A chart container whose fixed height cuts off the x-axis band.
- A tooltip as the only way to read a value.
- Any `fetch`, XHR, WebSocket or non-pinned external resource.
- Any fixed outer height, viewport-height layout, `position: fixed`, or horizontal
  overflow at 320px.
- Hard-coded colors outside the theme block.
- Explanatory paragraphs, formulas or instructions inside the file. Only labels,
  legends, values and accessible text belong there.
- Invented controls, KPI rows, cards or panels the user did not ask for.
- `innerHTML` built from labels or data values.
- A reply that mentions the file, the path, HTML, or this skill.
