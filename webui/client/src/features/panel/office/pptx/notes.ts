/**
 * 演示顺序与演讲者备注。pptx-preview 按「文件名里的数字」给幻灯片排序，
 * 而真实顺序在 presentation.xml 的 sldIdLst 里（手工调过页序的文件两者不一致），备注它也不读，这里补上。
 */

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export interface DeckMeta {
  /** 按演示顺序排列的幻灯片文件路径（如 ppt/slides/slide3.xml） */
  order: string[];
  /** 幻灯片文件路径 → 备注文本 */
  notes: Record<string, string>;
}

function resolveTarget(fromFile: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = fromFile.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** readXml：按 zip 内路径取 XML 文本，不存在返回 null（由调用方接到库已解压的 zip 上，避免二次解压） */
export async function readDeckMeta(readXml: (path: string) => Promise<string | null>): Promise<DeckMeta> {
  const parse = async (p: string) => {
    const s = await readXml(p);
    return s ? new DOMParser().parseFromString(s, 'application/xml') : null;
  };
  const rels = async (file: string) => {
    const doc = await parse(file.replace(/([^/]+)$/, '_rels/$1.rels'));
    return Array.from(doc?.getElementsByTagNameNS('*', 'Relationship') || []).map(r => ({ id: r.getAttribute('Id') || '', type: r.getAttribute('Type') || '', target: resolveTarget(file, r.getAttribute('Target') || '') }));
  };

  const meta: DeckMeta = { order: [], notes: {} };
  const presFile = 'ppt/presentation.xml';
  const pres = await parse(presFile);
  if (!pres) return meta;
  const presRels = await rels(presFile);
  for (const el of Array.from(pres.getElementsByTagNameNS('*', 'sldId'))) {
    const rid = el.getAttributeNS(REL_NS, 'id') || el.getAttribute('r:id');
    const target = presRels.find(r => r.id === rid)?.target;
    if (target) meta.order.push(target);
  }

  await Promise.all(meta.order.map(async slide => {
    const noteFile = (await rels(slide)).find(r => r.type.endsWith('/notesSlide'))?.target;
    const doc = noteFile ? await parse(noteFile) : null;
    if (!doc) return;
    // 备注页里还有幻灯片缩略图、页码等占位，只取 body 占位的那个文本框
    for (const sp of Array.from(doc.getElementsByTagNameNS('*', 'sp'))) {
      if (sp.getElementsByTagNameNS('*', 'ph')[0]?.getAttribute('type') !== 'body') continue;
      const text = Array.from(sp.getElementsByTagNameNS('*', 'p')).map(p =>
        Array.from(p.querySelectorAll('*')).map(n => (n.localName === 't' ? n.textContent || '' : n.localName === 'br' ? '\n' : '')).join(''),
      ).join('\n').trim();
      if (text) meta.notes[slide] = text;
    }
  }));
  return meta;
}
