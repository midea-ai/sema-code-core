#!/usr/bin/env node
/**
 * Layout check for a visualize skill artifact. Zero dependencies.
 *
 *   node check.mjs <file.html> [--no-screenshot]
 *
 * 1. ECharts layout check without a browser: the page's inline scripts run in a Node vm with a minimal DOM stub,
 *    echarts.init is redirected to server-side rendering (svg, ssr), then every text span in the zrender display
 *    list is measured. Reports text overlaps, text past the chart container, labels clipped by the plot area,
 *    fonts under 11px, text contrast against the theme background, and script errors. Runs at 720px and 320px
 *    page widths, each in the light theme (no data-theme) and the dark theme (<html data-theme="dark">): the
 *    custom properties of `:root {}` and `:root[data-theme="dark"] {}` are parsed from the <style> block and
 *    served through getComputedStyle, so a page that reads tokens() renders with the right colors per theme.
 *    Text widths are estimated (no canvas in Node), so distances are approximate.
 * 2. Theme lint: the dark token block must exist, no prefers-color-scheme, no hard-coded color literal in the
 *    script or in CSS rules outside the token blocks (selectors containing "mock" are exempt for UI mockups).
 * 3. Screenshot when a Chromium-based browser is installed (Chrome, Edge, Chromium, or $SEMA_VIZ_BROWSER):
 *    headless light-theme render at 720px into the system temp dir, path printed for the model to view.
 *
 * Exit code is always 0; the report on stdout is the result. Last line: `RESULT: OK` or `RESULT: <n> issue(s)`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// <root>/skills/visualize/scripts → <root>
const ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const CACHE_DIR = path.join(ROOT, 'cache', 'viz');
const WIDTHS = [720, 320];
const BODY_PADDING_X = 32; // body { padding: 12px 16px }
const MIN_FONT = 11;
const MAX_ISSUES = 20;
const ECHARTS_SRC_RE = /^https:\/\/cdn\.jsdelivr\.net\/npm\/echarts@(\d+\.\d+\.\d+)\/dist\/echarts\.min\.js$/;

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.log('usage: node check.mjs <file.html> [--no-screenshot]'); process.exit(0); }
const abs = path.resolve(file);
if (!fs.existsSync(abs)) { console.log(`RESULT: file not found: ${abs}`); process.exit(0); }
const html = fs.readFileSync(abs, 'utf8');
const wantShot = !args.includes('--no-screenshot');

const issues = [];
const notes = [];
const add = (scope, kind, text, hint) => issues.push({ scope, kind, text, hint });

// The file must live in <root>/attachments/<uuid>/: anywhere else the host will not render it inline and edits prompt for permission
const ATTACH_DIR = path.join(ROOT, 'attachments');
if (!/^[0-9a-f-]{36}$/i.test(path.basename(path.dirname(abs))) || path.resolve(path.dirname(path.dirname(abs))) !== ATTACH_DIR) {
  add('file', 'location', `file is at ${abs}`, `Get a path from path.mjs (${path.join(SCRIPT_DIR, 'path.mjs')} <title>), write the file there and check that file instead.`);
}

// ---------- HTML parsing (regex level; the file is our own contract, not arbitrary HTML) ----------
const scripts = [];
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  const attrs = m[1] || '';
  const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
  const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.toLowerCase();
  if (src) scripts.push({ src });
  else if (!type || /javascript|ecmascript/.test(type)) scripts.push({ code: m[2] });
  else if (type === 'module') scripts.push({ code: m[2], module: true });
}
const externals = scripts.filter(s => s.src).map(s => s.src);
const echartsSrc = externals.find(s => ECHARTS_SRC_RE.test(s));
const usesD3 = externals.some(s => /\/d3@/.test(s));

// CSS: selector → declared height in px (only what a container needs)
const cssHeights = new Map();
for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
  for (const rule of m[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const h = /(?:^|;)\s*height\s*:\s*(\d+(?:\.\d+)?)px/i.exec(rule[2]);
    if (!h) continue;
    for (const sel of rule[1].split(',')) cssHeights.set(sel.trim(), parseFloat(h[1]));
  }
}

// elements: document order, tag/id/classes/inline height
const elements = [];
for (const m of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
  const tag = m[1].toLowerCase();
  if (['script', 'style', 'meta', 'link', 'title', 'html', 'head', '!doctype'].includes(tag)) continue;
  const attrs = m[2] || '';
  const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
  const cls = (/\bclass\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] || '').split(/\s+/).filter(Boolean);
  const inlineH = /\bstyle\s*=\s*["'][^"']*height\s*:\s*(\d+(?:\.\d+)?)px/i.exec(attrs)?.[1];
  const dataset = {};
  for (const d of attrs.matchAll(/\bdata-([\w-]+)\s*=\s*["']([^"']*)["']/g)) dataset[d[1].replace(/-(\w)/g, (_, c) => c.toUpperCase())] = d[2];
  elements.push({ tag, id, cls, height: inlineH ? parseFloat(inlineH) : undefined, dataset });
}

// ---------- theme tokens and theme lint ----------
const cssText = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
const cssRules = [...cssText.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(r => ({ sel: r[1].trim().replace(/\s+/g, ' '), body: r[2] }));
const DARK_SEL = ':root[data-theme="dark"]';
function customProps(sel) {
  const out = {};
  for (const r of cssRules) {
    if (r.sel !== sel) continue;
    for (const d of r.body.split(';')) { const i = d.indexOf(':'); if (i < 0) continue; const k = d.slice(0, i).trim(); if (k.startsWith('--')) out[k] = d.slice(i + 1).trim(); }
  }
  return out;
}
const lightTokens = customProps(':root');
const darkOverrides = customProps(DARK_SEL);
const darkTokens = { ...lightTokens, ...darkOverrides };
const THEMES = [{ name: 'light', tokens: lightTokens }, { name: 'dark', tokens: darkTokens }];
const COLOR_LITERAL_RE = /#[0-9a-f]{3,8}\b|\brgba?\(/gi;
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
if (Object.keys(darkOverrides).length === 0) {
  add('file', 'theme', `no \`${DARK_SEL}\` token block`, 'Copy both token blocks from the skill Theme section verbatim; the host switches themes with <html data-theme="dark">.');
}
if (/prefers-color-scheme/.test(html)) {
  add('file', 'theme', 'uses prefers-color-scheme', 'The host picks the theme with data-theme on <html>; remove the media query and put the dark values under :root[data-theme="dark"].');
}
for (const s of scripts) {
  if (!s.code) continue;
  const hits = stripComments(s.code).match(COLOR_LITERAL_RE);
  if (hits) { add('file', 'theme', `${hits.length} hard-coded color(s) in the script, e.g. ${hits[0]}`, 'Take every color from tokens() at render time (skill Theme section); a literal keeps its light value when the host switches to dark.'); break; }
}
for (const r of cssRules) {
  if (r.sel.startsWith(':root') || /mock/i.test(r.sel) || r.sel.startsWith('@')) continue;
  const hits = stripComments(r.body).match(COLOR_LITERAL_RE);
  if (hits) { add('file', 'theme', `hard-coded color in CSS rule "${r.sel}": ${hits[0]}`, 'Use var(--token) so the rule follows the theme; product colors of a UI mockup belong on a .mockup root rule.'); break; }
}

// ---------- color math (WCAG relative luminance / contrast) ----------
function parseColor(c) {
  if (typeof c !== 'string') return null;
  c = c.trim().toLowerCase();
  let m;
  if ((m = /^#([0-9a-f]{3,4})$/.exec(c))) return [...m[1].slice(0, 3)].map(h => parseInt(h + h, 16));
  if ((m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(c))) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  if ((m = /^rgba?\(([^)]+)\)$/.exec(c))) { const p = m[1].split(/[\s,/]+/).slice(0, 3).map(Number); return p.length === 3 && p.every(n => !isNaN(n)) ? p : null; }
  return null;
}
function luminance(c) {
  const rgb = parseColor(c);
  if (!rgb) return null;
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const MIN_CONTRAST = 3;

function declaredHeight(tag, id, cls) {
  if (id && cssHeights.has('#' + id)) return cssHeights.get('#' + id);
  for (const c of cls) if (cssHeights.has('.' + c)) return cssHeights.get('.' + c);
  if (cssHeights.has(tag)) return cssHeights.get(tag);
  return undefined;
}

// ---------- minimal DOM stub ----------
function makeDom(contentWidth, log) {
  const byId = new Map();
  const all = [];
  const listeners = { DOMContentLoaded: [], load: [], resize: [] };

  class Style {
    constructor() { this._ = {}; }
    setProperty(k, v) { this._[k] = String(v); }
    getPropertyValue(k) { return this._[k] || ''; }
    removeProperty(k) { delete this._[k]; }
  }
  class ClassList {
    constructor(el) { this.el = el; }
    add(...c) { for (const x of c) if (!this.el.cls.includes(x)) this.el.cls.push(x); }
    remove(...c) { this.el.cls = this.el.cls.filter(x => !c.includes(x)); }
    toggle(c, f) { const has = this.el.cls.includes(c); if (f === undefined ? has : !f) this.remove(c); else this.add(c); return !has; }
    contains(c) { return this.el.cls.includes(c); }
  }
  class El {
    constructor(tag, id, cls, height, dataset) {
      this.tagName = tag.toUpperCase(); this.id = id || ''; this.cls = cls || []; this.declaredHeight = height;
      this.dataset = dataset || {}; this.children = []; this.parentElement = null; this.style = new Style();
      this.classList = new ClassList(this); this.attrs = {}; this._text = ''; this.value = ''; this.checked = false; this.disabled = false;
      this.ownerDocument = document; this.namespaceURI = ''; this.childNodes = this.children; this.hidden = false; this.title = '';
      all.push(this); if (id) byId.set(id, this);
    }
    get className() { return this.cls.join(' '); } set className(v) { this.cls = String(v).split(/\s+/).filter(Boolean); }
    get textContent() { return this._text; } set textContent(v) { this._text = String(v); this.children = []; }
    get innerText() { return this._text; } set innerText(v) { this._text = String(v); }
    get innerHTML() { return this._text; } set innerHTML(v) { this._text = String(v).replace(/<[^>]*>/g, ''); this.children = []; }
    get outerHTML() { return ''; }
    get firstChild() { return this.children[0] || null; } get lastChild() { return this.children[this.children.length - 1] || null; }
    get firstElementChild() { return this.firstChild; } get lastElementChild() { return this.lastChild; }
    get nextSibling() { return null; } get nextElementSibling() { return null; } get previousElementSibling() { return null; }
    get parentNode() { return this.parentElement; }
    get clientWidth() { return contentWidth; } get offsetWidth() { return contentWidth; }
    get clientHeight() { return this.declaredHeight ?? declaredHeight(this.tagName.toLowerCase(), this.id, this.cls) ?? 0; }
    get offsetHeight() { return this.clientHeight; } get scrollHeight() { return this.clientHeight; } get scrollWidth() { return contentWidth; }
    get scrollTop() { return 0; } set scrollTop(_) {} get scrollLeft() { return 0; } set scrollLeft(_) {}
    getBoundingClientRect() { const h = this.clientHeight; return { x: 0, y: 0, left: 0, top: 0, right: contentWidth, bottom: h, width: contentWidth, height: h }; }
    getClientRects() { return [this.getBoundingClientRect()]; }
    appendChild(c) { if (c && c.parentElement) c.parentElement.removeChild(c); if (c) { c.parentElement = this; this.children.push(c); } return c; }
    append(...cs) { for (const c of cs) if (typeof c === 'object') this.appendChild(c); else this._text += String(c); }
    prepend(...cs) { for (const c of cs.reverse()) if (typeof c === 'object') { c.parentElement = this; this.children.unshift(c); } }
    insertBefore(c, ref) { const i = this.children.indexOf(ref); c.parentElement = this; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentElement = null; return c; }
    replaceChildren(...cs) { this.children = []; this._text = ''; this.append(...cs); }
    replaceChild(n, o) { this.insertBefore(n, o); this.removeChild(o); return o; }
    remove() { if (this.parentElement) this.parentElement.removeChild(this); }
    contains(c) { let p = c; while (p) { if (p === this) return true; p = p.parentElement; } return false; }
    cloneNode() { return new El(this.tagName, '', [...this.cls], this.declaredHeight, { ...this.dataset }); }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') { this.id = String(v); byId.set(this.id, this); } if (k === 'class') this.className = v; if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v); }
    getAttribute(k) { if (k === 'id') return this.id; if (k === 'class') return this.className; return this.attrs[k] ?? null; }
    hasAttribute(k) { return this.getAttribute(k) != null; }
    removeAttribute(k) { delete this.attrs[k]; }
    toggleAttribute(k, f) { if (f === undefined ? this.hasAttribute(k) : !f) this.removeAttribute(k); else this.setAttribute(k, ''); }
    addEventListener() {} removeEventListener() {} dispatchEvent() { return true; }
    focus() {} blur() {} click() {} scrollIntoView() {} closest() { return null; } matches() { return false; }
    querySelector(s) { return query(s, this.children)[0] || null; }
    querySelectorAll(s) { return query(s, this.children); }
    getElementsByTagName(t) { return descendants(this.children).filter(e => e.tagName === t.toUpperCase()); }
    getContext() { return null; }
    getBBox() { return { x: 0, y: 0, width: 0, height: 0 }; }
    getComputedTextLength() { return 0; }
  }
  function descendants(list) { const out = []; for (const e of list) { out.push(e); out.push(...descendants(e.children)); } return out; }
  function matchCompound(e, comp) {
    for (const part of comp.match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|^[a-zA-Z][\w-]*|\*|:[\w-]+(\([^)]*\))?/g) || []) {
      if (part.startsWith('#')) { if (e.id !== part.slice(1)) return false; }
      else if (part.startsWith('.')) { if (!e.cls.includes(part.slice(1))) return false; }
      else if (part.startsWith('[')) { const [k, v] = part.slice(1, -1).split('='); const val = e.getAttribute(k.trim()); if (val == null) return false; if (v !== undefined && val !== v.replace(/^["']|["']$/g, '')) return false; }
      else if (part.startsWith(':')) { /* pseudo-classes ignored */ }
      else if (part !== '*' && e.tagName !== part.toUpperCase()) return false;
    }
    return true;
  }
  function query(sel, scope) {
    const pool = descendants(scope);
    const out = [];
    for (const alt of String(sel).split(',')) {
      const compound = alt.trim().split(/\s*[>~+]\s*|\s+/).filter(Boolean).pop();
      if (!compound) continue;
      for (const e of pool) if (matchCompound(e, compound) && !out.includes(e)) out.push(e);
    }
    return out;
  }
  const document = {
    readyState: 'complete', title: /<title>([^<]*)<\/title>/i.exec(html)?.[1] || '', hidden: false, visibilityState: 'visible',
    fonts: { ready: Promise.resolve(), addEventListener() {} },
    getElementById: id => byId.get(id) || null,
    querySelector: s => query(s, document.body.children)[0] || null,
    querySelectorAll: s => query(s, document.body.children),
    getElementsByTagName: t => descendants(document.body.children).filter(e => e.tagName === t.toUpperCase()),
    getElementsByClassName: c => descendants(document.body.children).filter(e => e.cls.includes(c)),
    createElement: t => new El(t), createElementNS: (_, t) => new El(t),
    createTextNode: t => ({ textContent: String(t), nodeType: 3 }),
    createDocumentFragment: () => new El('fragment'),
    addEventListener: (k, f) => { (listeners[k] ||= []).push(f); }, removeEventListener() {}, dispatchEvent() { return true; },
    currentScript: null,
  };
  const body = new El('body'); const root = new El('html'); const head = new El('head');
  root.appendChild(head); root.appendChild(body);
  document.body = body; document.documentElement = root; document.head = head;
  // Pre-register the static elements as a flat list under body; nesting is not tracked
  for (const e of elements) if (!['body', 'head'].includes(e.tag)) body.appendChild(new El(e.tag, e.id, e.cls, e.height, e.dataset));
  return { document, listeners, El };
}

// ---------- ECharts loader ----------
async function loadEcharts() {
  if (!echartsSrc) return null;
  const version = ECHARTS_SRC_RE.exec(echartsSrc)[1];
  const cached = path.join(CACHE_DIR, `echarts-${version}.js`);
  if (!fs.existsSync(cached)) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const res = await fetch(echartsSrc, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(cached, await res.text());
    } catch (e) {
      notes.push(`ECharts layout check skipped: could not download ${echartsSrc} (${e.message})`);
      return null;
    }
  }
  return createRequire(import.meta.url)(cached);
}

// ---------- run the page at one width ----------
async function runAt(width, echarts, theme) {
  const scope = theme.name === 'dark' ? `${width}px dark` : `${width}px`;
  const contentWidth = width - BODY_PADDING_X;
  const errors = [];
  const { document, listeners } = makeDom(contentWidth, errors);
  // The host sets the attribute before load; the page must read tokens from documentElement, so serve them there
  if (theme.name === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  const tk = theme.tokens;
  const bg = tk['--bg'] || '#ffffff';
  const computed = { fontFamily: tk['--font'] || 'system-ui, sans-serif', backgroundColor: bg, color: tk['--ink'] || '#0b0b0b', fontSize: '14px', getPropertyValue: k => tk[k] || '' };
  const charts = [];
  const timers = new Set();
  const echartsProxy = echarts && new Proxy(echarts, {
    get(t, k) {
      if (k === 'init') return (el, theme, opts) => {
        const w = (el && el.clientWidth) || contentWidth;
        let h = (el && el.clientHeight) || 0;
        if (!h) { h = 320; if (el) add(scope, 'height', `chart container${el.id ? ' #' + el.id : ''} has no explicit CSS height`, 'Give the container an explicit height (e.g. 320px) so the axis band is never cut off.'); }
        const chart = echarts.init(null, theme, { renderer: 'svg', ssr: true, width: w, height: h });
        // SSR renders the first frame; with animation on, labels sit at their animation start positions
        const setOption = chart.setOption.bind(chart);
        chart.setOption = (opt, ...rest) => setOption(opt && typeof opt === 'object' ? { ...opt, animation: false } : opt, ...rest);
        charts.push({ el, chart, w, h });
        return chart;
      };
      if (k === 'getInstanceByDom') return el => charts.find(c => c.el === el)?.chart;
      if (k === 'dispose') return el => { const c = charts.find(c => c.el === el || c.chart === el); c?.chart.dispose(); };
      return t[k];
    },
  });
  const win = {
    document, echarts: echartsProxy, console: { ...console, error: (...a) => errors.push(a.map(String).join(' ')), warn() {}, log() {}, info() {}, debug() {}, table() {} },
    innerWidth: width, innerHeight: 900, devicePixelRatio: 1, screen: { width, height: 900 },
    navigator: { language: 'zh-CN', languages: ['zh-CN'], userAgent: 'node-check', clipboard: {} },
    location: { href: 'file://' + abs, search: '', hash: '', protocol: 'file:' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    getComputedStyle: () => computed,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: f => { const t = setTimeout(() => f(Date.now()), 16); timers.add(t); return t; }, cancelAnimationFrame: t => clearTimeout(t),
    setTimeout: (f, ms, ...a) => { const t = setTimeout(f, Math.min(ms || 0, 50), ...a); timers.add(t); return t; }, clearTimeout,
    setInterval: (f, ms, ...a) => { const t = setInterval(f, Math.max(ms || 0, 50), ...a); timers.add(t); return t; }, clearInterval,
    addEventListener: (k, f) => { (listeners[k] ||= []).push(f); }, removeEventListener() {}, dispatchEvent() { return true; },
    performance, Event: class { constructor(type) { this.type = type; } }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    URL, URLSearchParams, Intl, Math, JSON, Date, Number, String, Array, Object, Promise, Map, Set, WeakMap, Symbol, RegExp, Error, TypeError, parseFloat, parseInt, isNaN, isFinite, structuredClone,
    fetch: () => Promise.reject(new Error('fetch is not allowed in a visualization')),
    alert() {}, scrollTo() {}, open() {}, getSelection: () => null,
  };
  win.window = win; win.self = win; win.globalThis = win; win.top = win; win.parent = win;
  const ctx = vm.createContext(win);
  // Browsers make these window properties unforgeable: a top-level `const top = ...` is a SyntaxError that
  // stops the whole script. Reproduce that so the checker catches it.
  win.__unforgeable = { window: win, document, location: win.location, top: win };
  vm.runInContext(`for (const k in __unforgeable) Object.defineProperty(globalThis, k, { value: __unforgeable[k], writable: false, configurable: false, enumerable: true });`, ctx);
  delete win.__unforgeable;

  for (const s of scripts) {
    if (!s.code) continue;
    try {
      vm.runInContext(s.code, ctx, { filename: path.basename(abs), timeout: 5000 });
    } catch (e) { errors.push(`${e.name}: ${e.message}`); }
  }
  for (const k of ['DOMContentLoaded', 'load']) for (const f of listeners[k] || []) { try { f({ type: k }); } catch (e) { errors.push(`${e.name}: ${e.message}`); } }
  await new Promise(r => setTimeout(r, 250));
  for (const t of timers) { clearTimeout(t); clearInterval(t); }

  for (const err of errors) {
    const reserved = /SyntaxError: Identifier '(window|document|location|top)' has already been declared/.exec(err);
    const domGap = /is not a function|is not defined|of undefined|of null|Cannot read/.test(err) && /document|window|canvas|getContext|SVG|d3|topojson|currentScript|Range|innerHTML/i.test(err);
    add(scope, 'script', `script error: ${err}`,
      reserved ? `'${reserved[1]}' is a reserved window property; a top-level declaration with that name is a SyntaxError in the browser and nothing in the script runs. Rename it and wrap the script body in an IIFE.`
      : err.startsWith('SyntaxError') ? 'A syntax error stops the whole script in the browser: nothing renders. Fix it.'
      : domGap ? 'The checker runs without a real DOM; if this only involves a browser API the page needs at runtime, ignore it. Otherwise fix it.' : 'Fix the script.');
  }
  if (echarts && charts.length === 0 && !usesD3) notes.push(`${scope}: no echarts.init call was reached`);

  for (const { el, chart, w, h } of charts) {
    try { analyzeChart(scope, el, chart, w, h, theme.name, bg); } catch (e) { notes.push(`${scope}: analysis failed (${e.message})`); }
    try { chart.dispose(); } catch { /* ignore */ }
  }
}

// ---------- measure text spans in a rendered ECharts instance ----------
function analyzeChart(scope, el, chart, W, H, themeName, bg) {
  const label = el && el.id ? `#${el.id}` : 'chart';
  const list = chart.getZr().storage.getDisplayList(true, false);
  const texts = [];
  for (const t of list) {
    if (t.type !== 'tspan' || t.ignore || t.invisible) continue;
    const s = t.style || {};
    if (!s.text || s.opacity === 0) continue;
    // owning component and hidden ancestors come from the chain; the effective clip is what zrender computed
    // for this span itself (__clipPaths), which already honors ignoreClip (e.g. ECharts end labels)
    let p = t, hidden = false, comp = '', clip = null;
    while (p) {
      if (p.ignore || p.invisible) hidden = true;
      if (!comp && p.__ecComponentInfo) comp = p.__ecComponentInfo.mainType;
      p = p.parent || p.__hostTarget;
    }
    if (hidden) continue;
    for (const cp of t.__clipPaths || []) { const cr = cp.getBoundingRect().clone(); const cm = cp.getComputedTransform(); if (cm) cr.applyTransform(cm); clip = clip ? intersectRect(clip, cr) : cr; }
    const r = t.getBoundingRect().clone(); const m = t.getComputedTransform(); if (m) r.applyTransform(m);
    texts.push({ text: String(s.text), comp: comp || 'text', font: s.fontSize || 12, fill: s.fill, r, clip });
  }
  const chartTexts = texts.filter(x => !/^\s*$/.test(x.text));
  const fmt = x => `"${x.text}" (${x.comp})`;
  if (args.includes('--dump')) for (const x of chartTexts) console.log(`  ${scope} ${label} ${fmt(x)} at ${[x.r.x, x.r.y, x.r.width, x.r.height].map(Math.round).join(',')} clip ${x.clip ? [x.clip.x, x.clip.y, x.clip.width, x.clip.height].map(Math.round).join(',') : '-'} font ${x.font}`);
  const seen = new Set();
  // 1. overlaps
  for (let i = 0; i < chartTexts.length; i++) for (let j = i + 1; j < chartTexts.length; j++) {
    const a = chartTexts[i], b = chartTexts[j];
    const ov = overlap(a.r, b.r, 1);
    if (ov <= 0) continue;
    const key = [a.text, b.text, a.comp, b.comp].join('|'); if (seen.has(key)) continue; seen.add(key);
    add(scope, 'overlap', `${label}: ${fmt(a)} overlaps ${fmt(b)} by ${Math.round(ov)}px`, overlapHint(a, b));
  }
  // 2. clipped by the plot area, else beyond the chart container
  for (const x of chartTexts) {
    const clipped = x.clip && outside(x.r, x.clip);
    if (clipped && clipped.by >= 1) { add(scope, 'clipped', `${label}: ${fmt(x)} is clipped by the plot area (${Math.round(clipped.by)}px past its ${clipped.side} edge)`, 'Keep the label inside the plot (label position, axis min/max or boundaryGap), or set series.clip: false when it is a value label on a mark.'); continue; }
    const out = outside(x.r, { x: 0, y: 0, width: W, height: H });
    if (out) add(scope, 'outside', `${label}: ${fmt(x)} extends ${Math.round(out.by)}px past the ${out.side} edge of the chart container`, outsideHint(x, out.side));
  }
  // 3. contrast against the page background of this theme. Near-white fills are labels drawn inside a mark
  // and sit on the series color, not the background, so they are skipped; unparsable fills (auto/inherit) too.
  const bgL = luminance(bg);
  if (bgL != null) {
    const seenFill = new Set();
    for (const x of chartTexts) {
      const l = luminance(x.fill);
      if (l == null || l > 0.9 || seenFill.has(x.fill)) continue;
      const ratio = contrast(l, bgL);
      if (ratio >= MIN_CONTRAST) continue;
      seenFill.add(x.fill);
      add(scope, 'contrast', `${label}: ${fmt(x)} in ${x.fill} has ${ratio.toFixed(1)}:1 contrast on the ${themeName} background ${bg}`,
        'Text colors come from tokens() at render time (ink / ink-2 / muted), never from a literal, and the chart is rebuilt in render() on data-theme change.');
    }
  }
  // 4. small fonts
  const small = chartTexts.filter(x => x.font < MIN_FONT);
  if (small.length) add(scope, 'font', `${label}: ${small.length} text(s) under ${MIN_FONT}px, e.g. ${fmt(small[0])} at ${small[0].font}px`, `Use at least ${MIN_FONT}px for every visible text.`);
  if (chartTexts.length === 0) notes.push(`${scope}: ${label} rendered no text (empty chart or unsupported series type)`);
}

function intersectRect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) };
}
function overlap(a, b, shrink) {
  const ix = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) - shrink * 2;
  const iy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) - shrink * 2;
  return ix > 0 && iy > 0 ? Math.min(ix, iy) : 0;
}
function outside(r, box) {
  const tol = 0.5;
  const sides = [
    ['left', box.x - r.x], ['right', r.x + r.width - (box.x + box.width)],
    ['top', box.y - r.y], ['bottom', r.y + r.height - (box.y + box.height)],
  ].filter(([, by]) => by > tol).sort((a, b) => b[1] - a[1]);
  return sides.length ? { side: sides[0][0], by: sides[0][1] } : null;
}
function overlapHint(a, b) {
  const comps = [a.comp, b.comp];
  if (comps.includes('legend') && comps.includes('yAxis')) return 'The axis name collides with the legend: put the unit in the subtitle or axisLabel.formatter instead of yAxis.name, or move the legend to the bottom, or raise grid.top.';
  if (comps.includes('legend')) return 'Raise grid.top (or grid.bottom for a bottom legend) so the legend has its own band.';
  if (a.comp === 'xAxis' && b.comp === 'xAxis') return 'Category labels collide: show fewer ticks (axisLabel.interval), rotate them, or switch to horizontal bars.';
  if (a.comp === 'series' && b.comp === 'series') return 'Data labels collide: label fewer points, or set labelLayout: { hideOverlap: true }.';
  if (comps.includes('title')) return 'Move the title into the HTML heading and drop the in-chart title.';
  return 'Move one of the texts, or reserve more space for it.';
}
function outsideHint(x, side) {
  if (x.comp === 'series') return `Reserve room for the label: increase grid.${side} to the label width plus 8px (e.g. 56 for a short end label).`;
  if (x.comp === 'legend') return 'The legend does not fit: let it wrap (legend.type default) or move it to the bottom.';
  return `Increase grid.${side} or the container height so the text fits.`;
}

// ---------- screenshot via a locally installed Chromium browser ----------
function findBrowser() {
  if (process.env.SEMA_VIZ_BROWSER && fs.existsSync(process.env.SEMA_VIZ_BROWSER)) return process.env.SEMA_VIZ_BROWSER;
  const p = process.platform;
  const candidates = p === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ] : p === 'win32' ? [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
  ] : [];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  if (p !== 'win32') for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}
async function screenshot() {
  const browser = findBrowser();
  if (!browser) return 'skipped: no Chromium-based browser found (set SEMA_VIZ_BROWSER to a chrome/msedge executable to enable)';
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sema-viz-'));
  const png = path.join(outDir, path.basename(abs).replace(/\.html?$/i, '') + '.png');
  const profile = path.join(outDir, 'profile');
  // A page with a running animation loop keeps headless Chrome alive after the screenshot is written,
  // so poll for the file and kill the browser instead of waiting for it to exit.
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    `--user-data-dir=${profile}`, `--window-size=${WIDTHS[0]},1000`, '--virtual-time-budget=5000', `--screenshot=${png}`, 'file://' + abs,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !exited) {
    if (fs.existsSync(png) && fs.statSync(png).size > 0) { await new Promise(r => setTimeout(r, 300)); break; }
    await new Promise(r => setTimeout(r, 200));
  }
  if (!exited) child.kill();
  if (!fs.existsSync(png)) return `skipped: browser did not produce an image (${stderr.trim().split('\n').pop() || 'unknown error'})`;
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  return `${png} (${WIDTHS[0]}x1000, page may be shorter than the image)`;
}

// ---------- main ----------
const echarts = await loadEcharts();
if (!echartsSrc && !usesD3) notes.push('no pinned ECharts script found; only script errors and the screenshot are checked');
if (usesD3) notes.push('D3 content is not measured by this checker; rely on the screenshot for it');
// Light first, then dark: a layout issue shows up under light and is deduplicated below; what remains under a
// dark scope is dark-only (a color literal, a render() path that breaks on re-render, low contrast)
const runs = [];
for (const theme of THEMES) for (const w of WIDTHS) { await runAt(w, echarts, theme); runs.push(theme.name === 'dark' ? `${w}px dark` : `${w}px`); }

// A narrower width or the other theme usually repeats the same issues; print each distinct issue once, at the first scope it appears
const seenText = new Set();
const distinct = issues.filter(i => { const k = `${i.kind}|${i.text.replace(/\d+px/g, '')}`; if (seenText.has(k)) return false; seenText.add(k); return true; });
const shown = distinct.slice(0, MAX_ISSUES);
for (const i of shown.filter(i => i.scope === 'file')) console.log(`[file] ${i.text}\n  fix: ${i.hint}`);
for (const scope of runs) {
  const mine = shown.filter(i => i.scope === scope);
  const total = issues.filter(i => i.scope === scope).length;
  console.log(`[layout ${scope}] ${total ? total + ' issue(s)' + (mine.length < total ? ` (${total - mine.length} same as above)` : '') : 'clean'}`);
  for (const i of mine) console.log(`- ${i.text}\n  fix: ${i.hint}`);
}
if (distinct.length > MAX_ISSUES) console.log(`(${distinct.length - MAX_ISSUES} more not shown)`);
for (const n of [...new Set(notes)]) console.log(`note: ${n}`);
if (wantShot) console.log(`[screenshot] ${distinct.length ? 'skipped until the issues above are fixed' : await screenshot()}`);
console.log(distinct.length ? `RESULT: ${distinct.length} issue(s)` : 'RESULT: OK');
process.exit(0);
