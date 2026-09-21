import { useEffect, useRef, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { t } from '../../../../i18n';
import { loadECharts, loadExcel } from '../loaders';
import { toEChartsOption } from './charts';
import type { Anchor } from './model';

/**
 * 网格上的内嵌图表：有图表定义就用 echarts 画，解析不出定义 / 渲染失败时退回占位框。
 * 图表始终按 100% 下的尺寸渲染，缩放交给 CSS transform——字号、线宽随表格一起缩放，缩放时也不用重建实例。
 */
export function ChartBox({ anchor, scale }: { anchor: Anchor; scale: number }) {
  const { chart, x, y, w, h } = anchor;
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!chart) return;
    let alive = true;
    let inst: { dispose(): void } | null = null;
    setFailed(false);
    // numfmt 随表格解析已经加载过，这里只是取同一个单例：数据标签 / 提示里的数值按单元格的数字格式显示
    Promise.all([loadECharts(), loadExcel()]).then(([ec, { numfmt }]) => {
      if (!alive || !ref.current) return;
      const c = ec.init(ref.current, null, { renderer: 'svg', width: w, height: h });
      inst = c;
      c.setOption(toEChartsOption(chart, (v, code) => { try { return numfmt.format(code || 'General', v); } catch { return String(v); } }, t('office.chartOther')));
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; inst?.dispose(); };
  }, [chart, w, h]);

  const box = { left: x * scale, top: y * scale, width: w * scale, height: h * scale };
  if (!chart || failed) {
    return (
      <div className="absolute z-[2] bg-white border border-dashed border-border flex flex-col items-center justify-center gap-1 text-muted text-xs font-sans" style={box}>
        <BarChart3 size={20} />{chart?.title || t('office.chart')}
      </div>
    );
  }
  return (
    // 图表上的点击不往下传：否则会选中被它盖住的单元格
    <div className="absolute z-[2] bg-white border border-border overflow-hidden cursor-default font-sans" style={box} onMouseDown={e => e.stopPropagation()}>
      <div ref={ref} style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: '0 0' }} />
    </div>
  );
}
