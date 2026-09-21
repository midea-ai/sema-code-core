/** fast-formula-parser 不带类型声明：只声明用到的部分 */
declare module 'fast-formula-parser' {
  export interface CellRef { sheet: string; row: number; col: number }
  export interface RangeRef { sheet: string; from: { row: number; col: number }; to: { row: number; col: number } }
  /** 传给函数实现的实参包装：区域 / 数组的 value 是二维数组 */
  export interface FnArg { value: any; isArray: boolean; omitted?: boolean }
  export default class FormulaParser {
    constructor(config?: {
      functions?: Record<string, (...args: any[]) => unknown>;
      onCell?: (ref: CellRef) => unknown;
      onRange?: (ref: RangeRef) => unknown[][];
    });
    parse(formula: string, position: CellRef): unknown;
    supportedFunctions(): string[];
    /** 内置 + 自定义函数表 */
    functions: Record<string, (...args: any[]) => unknown>;
    /** 运算符求值入口（实例属性，可覆盖） */
    utils: any;
    /** 只分析依赖不求值 */
    static DepParser: new () => { parse(formula: string, position: CellRef): Array<CellRef | RangeRef> };
  }
}
