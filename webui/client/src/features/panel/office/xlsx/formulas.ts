/**
 * 公式重算：xlsx 里公式的「显示值」是 Excel 算完后缓存进文件的；openpyxl 等库只写公式不写值，
 * 没被 Excel 打开保存过的文件（agent 生成的表格基本都是）公式格全是空的，图表也取不到数。这里在预览端补算。
 * - 只算缺缓存的公式：有缓存一律信缓存（与 Excel 显示一致，也快）。
 * - fast-formula-parser 负责解析求值，它没实现的函数（SUMIFS / COUNTIFS / AVERAGEIFS 等）转给 @formulajs/formulajs。
 * - 逐格记忆化；循环引用、不支持的函数、外部工作簿引用等算不出的一律留空，不影响其它格子。
 *
 * 对引擎的两处补强（都在实例上做，不碰 node_modules）：
 * - 数组运算：引擎的运算符遇到区域只取第一个元素，SUMPRODUCT((A2:A9="华东")*H2:H9) 这类极常见的写法会被静默算错
 *   （算错比留空糟糕得多）。这里覆盖运算符入口，给区域 / 数组操作数补上逐元素广播；IF 的数组条件同理。
 * - 求值顺序：解析器实例不可重入，边求值边递归去算依赖会把外层的解析状态冲掉；长依赖链（逐行累计）还会爆栈。
 *   所以先用依赖分析器拿到静态依赖，按「依赖先行」用显式栈算完，轮到自己时依赖都已就绪，不发生嵌套。
 *   只有 INDIRECT / OFFSET 这类运行时才知道引用谁的，才会真的嵌套，此时按嵌套深度换用独立的解析器实例。
 */
import type { CellRef, RangeRef } from 'fast-formula-parser';
import { dateToSerial } from './format';

type FormulaParserCtor = typeof import('fast-formula-parser').default;
type ParserInst = InstanceType<FormulaParserCtor>;

/** 缓存值缺失：没有 <v>，或是空的 <v></v> */
export const isMissing = (v: unknown) => v == null || v === '';

/** 按 工作表名 + 1 基行列 取单元格的值；公式格缺缓存时现算。错误值返回 { error: '#DIV/0!' } */
export type Calc = (sheet: string, row: number, col: number) => unknown;

const FORMULA = 6; // ExcelJS ValueType.Formula
const MAX_NEST = 8; // 动态引用造成的嵌套求值深度上限

/** 工作簿里有没有缺缓存的公式：没有就不必加载公式引擎 */
export function needsCalc(wb: any): boolean {
  for (const ws of wb.worksheets as any[]) {
    for (const row of (ws._rows || []) as any[]) {
      for (const cell of (row?._cells || []) as any[]) if (cell && cell.type === FORMULA && isMissing(cell.result)) return true;
    }
  }
  return false;
}

// ---------- 数组广播 ----------

type Grid = unknown[][];
const asGrid = (v: unknown): Grid | null => (Array.isArray(v) ? (Array.isArray(v[0]) ? v as Grid : [v]) : null);
/** 逐元素套用：单行 / 单列 / 标量按 Excel 的规则沿另一方向重复 */
function broadcast(a: unknown, b: unknown, fn: (x: unknown, y: unknown) => unknown): Grid {
  const A = asGrid(a), B = asGrid(b);
  const rows = Math.max(A ? A.length : 1, B ? B.length : 1), cols = Math.max(A ? A[0].length : 1, B ? B[0].length : 1);
  const at = (G: Grid | null, v: unknown, r: number, c: number) => (G ? G[G.length === 1 ? 0 : r]?.[G[0].length === 1 ? 0 : c] ?? null : v);
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => fn(at(A, a, r, c), at(B, b, r, c))));
}

function patchArrayOps(p: ParserInst) {
  const u = p.utils;
  u.applyInfix = (v1: unknown, infix: string, v2: unknown) => {
    const r1 = u.extractRefValue(v1), r2 = u.extractRefValue(v2);
    if (!Array.isArray(r1.val) && !Array.isArray(r2.val)) return u._applyInfix(r1, infix, r2);
    return broadcast(r1.val, r2.val, (x, y) => u._applyInfix({ val: x, isArray: false }, infix, { val: y, isArray: false }));
  };
  u.applyPrefix = (prefixes: unknown, v: unknown) => {
    const r = u.extractRefValue(v);
    return Array.isArray(r.val) ? broadcast(r.val, null, x => u._applyPrefix(prefixes, x, false)) : u._applyPrefix(prefixes, r.val, r.isArray);
  };
  u.applyPostfix = (v: unknown, postfix: unknown) => {
    const r = u.extractRefValue(v);
    return Array.isArray(r.val) ? broadcast(r.val, null, x => u._applyPostfix(x, false, postfix)) : u._applyPostfix(r.val, r.isArray, postfix);
  };
}

// 函数表只建一次：formulajs 里全大写命名的导出即 Excel 函数，解析器自带的优先；IF 换成支持数组条件的版本
let extraFns: Record<string, (...args: any[]) => unknown> | null = null;
function extraFunctions(Parser: FormulaParserCtor, formulajs: Record<string, unknown>) {
  if (extraFns) return extraFns;
  const probe = new Parser();
  const own = new Set(probe.supportedFunctions());
  // 解析器把实参包成 { value, isArray, … }，区域的 value 是二维数组；formulajs 吃裸值
  const unwrap = (a: any) => (a && typeof a === 'object' && 'value' in a ? a.value : a);
  extraFns = {};
  for (const [name, fn] of Object.entries(formulajs)) {
    if (typeof fn !== 'function' || !/^[A-Z][A-Z0-9.]*$/.test(name) || own.has(name)) continue;
    extraFns[name] = (...args: any[]) => {
      const r = (fn as (...a: unknown[]) => unknown)(...args.map(unwrap));
      if (r instanceof Error) throw r;
      return r;
    };
  }
  const builtinIf = probe.functions.IF;
  const truthy = (v: unknown) => (typeof v === 'string' ? v.toUpperCase() === 'TRUE' : !!v);
  // IF 在引擎里属于「需要上下文、且不预取数据」的函数：第一个实参是解析器本身，其余是未解引用的原始节点
  //（条件经过上面的运算符广播后是裸二维数组；两个分支可能是还没取值的区域引用，省略时为 null）
  extraFns.IF = (ctx: ParserInst, cond: unknown, yes: unknown, no: unknown) => {
    const deref = (a: unknown) => (a == null ? a : ctx.utils.extractRefValue(a).val);
    const c = deref(cond);
    if (!Array.isArray(c)) return builtinIf(ctx, cond, yes, no);
    const pick = broadcast(c, yes == null ? true : deref(yes), (t, y) => (truthy(t) ? y : undefined));
    return broadcast(pick, no == null ? false : deref(no), (y, n) => (y === undefined ? n : y));
  };
  return extraFns;
}

// ---------- 计算器 ----------

export function createCalc(wb: any, date1904: boolean, Parser: FormulaParserCtor, formulajs: Record<string, unknown>): Calc {
  const memo = new Map<string, unknown>();
  const visiting = new Set<string>();
  const keyOf = (r: CellRef) => `${r.sheet}\n${r.row}\n${r.col}`;
  const cellAt = (r: CellRef) => wb.getWorksheet(r.sheet)?.findCell(r.row, r.col);
  const pending = (cell: any) => !!cell && cell.type === FORMULA && isMissing(cell.result);

  const plain = (v: any): unknown => {
    if (v instanceof Date) return dateToSerial(v, date1904);
    if (v && typeof v === 'object') return v.error ? v : Array.isArray(v.richText) ? v.richText.map((x: any) => x.text).join('') : v.text ?? v.result ?? null;
    return v ?? null;
  };

  // 已用范围按表缓存：ExcelJS 的 columnCount 每次取都要遍历全部行。整列 / 整行引用（A:A）据此截断，否则要遍历一百万行
  const usedCache = new Map<string, { rows: number; cols: number }>();
  const usedOf = (sheet: string) => {
    let u = usedCache.get(sheet);
    if (!u) { const ws = wb.getWorksheet(sheet); u = { rows: ws?.rowCount || 0, cols: ws?.columnCount || 0 }; usedCache.set(sheet, u); }
    return u;
  };

  const value = (ref: CellRef): unknown => {
    const cell = cellAt(ref);
    if (!cell) return null;
    if (cell.type !== FORMULA) return plain(cell.value);
    if (!isMissing(cell.result)) return plain(cell.result);
    const k = keyOf(ref);
    if (!memo.has(k)) {
      if (visiting.has(k)) return null; // 循环引用
      ensure(ref);
    }
    return memo.get(k) ?? null;
  };
  // 传给引擎的值：错误值按空处理，避免一个错格把整条依赖链都带成异常
  const feed = (ref: CellRef) => { const v: any = value(ref); return v && typeof v === 'object' ? null : v; };

  const functions = extraFunctions(Parser, formulajs);
  const parsers: ParserInst[] = [];
  let nest = 0;
  const parserAt = (depth: number) => {
    if (!parsers[depth]) {
      const p = new Parser({
        functions,
        onCell: ref => feed(ref),
        onRange: ref => {
          const used = usedOf(ref.sheet);
          const r2 = Math.min(ref.to.row, used.rows), c2 = Math.min(ref.to.col, used.cols);
          const out: unknown[][] = [];
          for (let r = ref.from.row; r <= r2; r++) {
            const line: unknown[] = [];
            for (let c = ref.from.col; c <= c2; c++) line.push(feed({ sheet: ref.sheet, row: r, col: c }));
            out.push(line);
          }
          return out;
        },
      });
      patchArrayOps(p);
      parsers[depth] = p;
    }
    return parsers[depth];
  };

  const evaluate = (ref: CellRef): unknown => {
    if (nest >= MAX_NEST) return null;
    const p = parserAt(nest++);
    try {
      let r: any = p.parse(cellAt(ref).formula, ref);
      // 区域 / 数组结果取左上角（不做动态数组溢出）
      while (Array.isArray(r)) r = r[0];
      // Excel 语义的错误值（#DIV/0! 等）由 parse 返回而不是抛出，照样显示出来
      return r && typeof r === 'object' ? (r.error ? { error: String(r.error) } : plain(r)) : r ?? null;
    } catch { return null; /* 不支持的函数、语法不认识等：留空 */ } finally { nest--; }
  };

  /** 静态依赖里还没算的公式格 */
  const deps = new Parser.DepParser();
  const pendingDeps = (ref: CellRef): CellRef[] => {
    let refs: Array<CellRef | RangeRef> = [];
    try { refs = deps.parse(cellAt(ref).formula, ref); } catch { /* 依赖分析不了就直接求值，求不出会留空 */ }
    const out: CellRef[] = [];
    for (const d of refs) {
      if (!('from' in d)) { if (pending(cellAt(d))) out.push(d); continue; }
      const rows: any[] = wb.getWorksheet(d.sheet)?._rows || [];
      const r2 = Math.min(d.to.row, rows.length);
      for (let r = d.from.row; r <= r2; r++) {
        const cells: any[] = rows[r - 1]?._cells || [];
        const c2 = Math.min(d.to.col, cells.length);
        for (let c = d.from.col; c <= c2; c++) if (pending(cells[c - 1])) out.push({ sheet: d.sheet, row: r, col: c });
      }
    }
    return out;
  };

  /** 依赖先行：显式栈做后序遍历，不递归，逐行累计这类上万层的依赖链也不会爆栈 */
  const ensure = (root: CellRef) => {
    const stack = [root];
    while (stack.length) {
      const cur = stack[stack.length - 1], k = keyOf(cur);
      if (memo.has(k)) { stack.pop(); continue; }
      if (!visiting.has(k)) {
        visiting.add(k);
        for (const d of pendingDeps(cur)) { const dk = keyOf(d); if (!memo.has(dk) && !visiting.has(dk)) stack.push(d); }
        continue;
      }
      memo.set(k, evaluate(cur));
      visiting.delete(k);
      stack.pop();
    }
  };

  return (sheet, row, col) => value({ sheet, row, col });
}
