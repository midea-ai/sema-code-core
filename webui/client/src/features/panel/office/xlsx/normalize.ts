/**
 * 把「XML 上合法、但 ExcelJS 读不了」的写法归一化成它认识的形态。ExcelJS 按字面量匹配标签名、属性名和部件路径，
 * 不是按命名空间 / 关系解析的；不同生成器写出的合法 xlsx 会各自踩雷（Excel 自己都能正常打开）：
 * 1. 主命名空间带前缀：<x:workbook><x:sheets><x:sheet …>（.NET Open XML SDK）。它一个标签都认不出，
 *    workbook 模型为空，报 Cannot read properties of undefined (reading 'sheets')。
 * 2. 关系命名空间的前缀不叫 r：<sheet rel:id="…">。它只认字面量 r:id，取不到关系，报 reading 'Target'。
 * 3. 工作表 rels 用包内绝对路径：Target="/xl/tables/table1.xml"。它按相对形式 ../tables/table1.xml 作键查表，
 *    查不到就是 undefined，报 reading 'name'。
 * 4. 工作表部件不叫 sheetN.xml：它按文件名正则收集工作表，别的名字直接被忽略——不报错，那张表悄悄丢了。
 */
import type JSZip from 'jszip';

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const BOM = String.fromCharCode(0xFEFF);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
// 根元素形如 <x:workbook … xmlns:x="…main"：取出绑定到主命名空间的前缀
const PREFIXED_ROOT = new RegExp(`<([A-Za-z_][\\w.-]*):[\\w.-]+[^>]*\\sxmlns:\\1="${esc(MAIN_NS)}"`);
const REL_PREFIX = new RegExp(`\\sxmlns:([A-Za-z_][\\w.-]*)="${esc(REL_NS)}"`);
const stripBom = (s: string) => (s.startsWith(BOM) ? s.slice(1) : s);

/** 1、2：前缀归一化。返回改写后的文本，不需要改则原样返回 */
function normalizePrefixes(src: string): string {
  let out = stripBom(src);
  const head = out.slice(0, 4096);
  const main = head.match(PREFIXED_ROOT)?.[1];
  // 已经另有默认命名空间声明的不动：把前缀声明改成默认声明会撞车
  if (main && !/<[^>]*\sxmlns="/.test(head)) {
    out = out.replace(new RegExp(`<(/?)${esc(main)}:`, 'g'), '<$1').replace(new RegExp(`xmlns:${esc(main)}="${esc(MAIN_NS)}"`, 'g'), `xmlns="${MAIN_NS}"`);
  }
  const rel = out.match(REL_PREFIX)?.[1];
  // r 已被别的命名空间占用的不动
  if (rel && rel !== 'r' && !/\sxmlns:r="/.test(out)) {
    out = out.replace(new RegExp(`xmlns:${esc(rel)}="${esc(REL_NS)}"`, 'g'), `xmlns:r="${REL_NS}"`).replace(new RegExp(`(\\s)${esc(rel)}:([\\w.-]+=")`, 'g'), '$1r:$2');
  }
  return out;
}

/** 4：把不叫 sheetN.xml 的工作表部件改名（连同它的 rels），并同步 workbook rels 与 [Content_Types].xml */
async function renameSheetParts(zip: JSZip): Promise<boolean> {
  const relsFile = zip.file('xl/_rels/workbook.xml.rels');
  if (!relsFile) return false;
  let rels = stripBom(await relsFile.async('string'));
  const used = new Set<number>();
  for (const n of Object.keys(zip.files)) { const m = n.match(/^xl\/worksheets\/sheet(\d+)\.xml$/); if (m) used.add(Number(m[1])); }
  const moves: Array<{ from: string; to: string; tag: string; target: string }> = [];
  for (const tag of rels.match(/<Relationship\b[^>]*>/g) || []) {
    if (!/Type="[^"]*\/worksheet"/.test(tag)) continue;
    const target = tag.match(/Target="([^"]*)"/)?.[1];
    if (!target) continue;
    const from = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    // 只处理就在 xl/worksheets/ 下、仅文件名不合规的：挪目录会让它 rels 里的相对路径失效
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(from) || /^xl\/worksheets\/sheet\d+\.xml$/.test(from) || !zip.file(from)) continue;
    let n = 1;
    while (used.has(n)) n++;
    used.add(n);
    moves.push({ from, to: `xl/worksheets/sheet${n}.xml`, tag, target });
  }
  if (!moves.length) return false;
  const types = zip.file('[Content_Types].xml');
  let ct = types ? stripBom(await types.async('string')) : '';
  for (const m of moves) {
    zip.file(m.to, await zip.file(m.from)!.async('uint8array'));
    zip.remove(m.from);
    const oldRels = m.from.replace(/([^/]+)$/, '_rels/$1.rels'), partRels = zip.file(oldRels);
    if (partRels) { zip.file(m.to.replace(/([^/]+)$/, '_rels/$1.rels'), await partRels.async('uint8array')); zip.remove(oldRels); }
    rels = rels.replace(m.tag, m.tag.replace(`Target="${m.target}"`, `Target="${m.to.slice(3)}"`));
    ct = ct.split(`"/${m.from}"`).join(`"/${m.to}"`);
  }
  zip.file('xl/_rels/workbook.xml.rels', rels);
  if (types) zip.file('[Content_Types].xml', ct);
  return true;
}

/** 就地改写 zip 里需要归一化的部件；返回是否改过（改过才需要重新打包交给 ExcelJS） */
export async function normalizeForExcelJS(zip: JSZip): Promise<boolean> {
  // 先改名：后面按 xl/worksheets/_rels/ 归一化绝对路径时，新名字的 rels 才会被扫到
  let changed = await renameSheetParts(zip);
  for (const name of Object.keys(zip.files)) {
    const file = zip.file(name);
    if (!file) continue;
    if (/^xl\/.*\.xml$/.test(name)) {
      const src = await file.async('string');
      const out = normalizePrefixes(src);
      if (out !== src) { zip.file(name, out); changed = true; }
    } else if (/^xl\/worksheets\/_rels\/[^/]+\.rels$/.test(name)) {
      // 3：绝对路径 → 相对路径
      const src = await file.async('string');
      const out = stripBom(src).replace(/Target="\/xl\//g, 'Target="../');
      if (out !== src) { zip.file(name, out); changed = true; }
    }
  }
  return changed;
}
