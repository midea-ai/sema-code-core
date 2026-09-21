import { Dropdown } from '../../../common/ui';

/** 缩放取值：'fit' 或百分比数字串（如 '150'） */
export type Zoom = string;

/** 缩放下拉：固定档位 + 可选的底部「适应」项；适应时按钮上显示实际百分比（图片与 Office 预览共用） */
export function ZoomDropdown({ value, levels, onChange, fitLabel, fitPct }: {
  value: Zoom; levels: number[]; onChange: (v: Zoom) => void;
  /** 「适应」项文案；不传则没有适应项 */
  fitLabel?: string;
  /** 适应时的实际缩放百分比（未量出时显示 fitLabel） */
  fitPct?: number | null;
}) {
  return (
    <Dropdown value={value} options={levels.map(v => ({ value: String(v), label: `${v}%` }))} onChange={onChange} minWidth={140}
      renderValue={v => <span>{v === 'fit' ? (fitPct != null ? `${fitPct}%` : fitLabel) : `${v}%`}</span>}
      footer={fitLabel ? close => (
        <button onClick={() => { onChange('fit'); close(); }} className="w-full flex items-center gap-2.5 text-left px-3 py-1.5 rounded hover:bg-black/[0.05] text-sm">
          <span className="flex-1">{fitLabel}</span>
          {value === 'fit' && <svg width="14" height="14" viewBox="0 0 24 24" className="text-ok shrink-0"><path d="M5 12l5 5L20 7" stroke="currentColor" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        </button>
      ) : undefined} />
  );
}
