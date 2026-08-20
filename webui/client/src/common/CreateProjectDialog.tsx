import { useEffect, useRef, useState } from 'react';
import { Folder, FolderPlus, X } from 'lucide-react';
import { Modal, cn } from './ui';
import { api } from '../api/http';
import { useApp } from '../store/app';
import type { ProjectRecord } from '../../../shared/types';
import { t } from '../i18n';

/**
 * 创建项目弹窗（对齐参考效果）：项目名称 + 可选源文件夹。
 * 选了文件夹 = 导入该目录（记录 realpath，不拷贝）；未选 = 在 ~/Documents/Sema/<名称> 新建目录。
 */
export function CreateProjectDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (p: ProjectRecord) => void }) {
  const toast = useApp(s => s.toast);
  const [name, setName] = useState('');
  const [dir, setDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setName(''); setDir(null); setBusy(false); setTimeout(() => input.current?.focus(), 0); } }, [open]);

  const pickDir = async () => {
    let picked: string | null = null;
    try { picked = (await api<{ path: string | null }>('POST', '/api/projects/pick-directory')).path; } catch { /* ignore */ }
    if (!picked) {
      const typed = window.prompt(t('dialog.importPath'), dir || '');
      picked = typed && typed.trim() ? typed.trim() : null;
    }
    if (!picked) return;
    setDir(picked);
    // 未填名称时用目录名
    if (!name.trim()) setName(picked.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '');
  };

  const canCreate = !!name.trim() && !busy;
  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      const p = dir ? await useApp.getState().importProject(dir, name.trim()) : await useApp.getState().createProject(name.trim());
      onCreated?.(p);
      onClose();
    } catch (e: any) { toast(e.message, 'error'); setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} width={480}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-lg font-semibold">{t('project.createTitle')}</div>
        <button onClick={onClose} className="p-1 rounded text-muted hover:text-fg hover:bg-black/[0.05]"><X size={15} /></button>
      </div>
      <label className="flex items-center gap-2 h-10 px-3 rounded-lg border border-border focus-within:border-accent/60 focus-within:ring-1 focus-within:ring-accent/25">
        <Folder size={15} className="text-muted shrink-0" strokeWidth={1.75} />
        <input ref={input} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') create(); }}
          placeholder={t('dialog.projectName')} className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted/60" />
      </label>
      <div className="mt-4 mb-2 text-sm font-medium">{t('project.sourceFolder')}</div>
      {dir ? (
        <div className="flex items-center gap-2 h-11 px-3 rounded-lg border border-border">
          <Folder size={15} className="text-muted shrink-0" strokeWidth={1.75} />
          <span className="flex-1 truncate text-sm" title={dir}>{dir}</span>
          <button onClick={pickDir} className="text-xs text-muted hover:text-fg">{t('project.changeFolder')}</button>
          <button onClick={() => setDir(null)} className="p-1 rounded text-muted hover:text-fg hover:bg-black/[0.05]" title={t('project.clearFolder')}><X size={13} /></button>
        </div>
      ) : (
        <button onClick={pickDir} className="w-full h-24 rounded-xl border border-border hover:bg-black/[0.02] flex flex-col items-center justify-center gap-1.5 text-sm">
          <FolderPlus size={18} className="text-fg/80" strokeWidth={1.5} />
          <span>{t('project.addFolderHint')}</span>
        </button>
      )}
      <div className="mt-5 flex items-center justify-end gap-2">
        <button onClick={onClose} className="h-9 px-4 rounded-lg text-sm text-muted hover:text-fg hover:bg-black/[0.05]">{t('dialog.cancel')}</button>
        <button onClick={create} disabled={!canCreate}
          className={cn('h-9 px-4 rounded-lg text-sm text-white', canCreate ? 'bg-primary hover:bg-black' : 'bg-black/20 cursor-default')}>{t('project.create')}</button>
      </div>
    </Modal>
  );
}
