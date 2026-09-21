/**
 * 交给 pptx-preview 之前的容错处理。库按 [Content_Types].xml 的 Override 逐个去 zip 里取部件，
 * 遇到不存在的直接抛错，而且被它自己吞掉——结果是解析出 0 张幻灯片、不报错、界面一片空白。
 * pptxgenjs 生成的文件必踩：它给每张幻灯片都声明一个 slideMasterN.xml，包里实际只有 slideMaster1.xml（PowerPoint 能容忍）。
 * 这里把指向不存在部件的 Override 摘掉；没有悬空声明就原样返回，不重新打包。
 */
import { loadZip } from '../loaders';

const TYPES_FILE = '[Content_Types].xml';

export async function dropDanglingParts(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const zip = await (await loadZip()).loadAsync(buf);
  const xml = await zip.file(TYPES_FILE)?.async('text');
  if (!xml) return buf;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  // 与库的取法保持一致：PartName 去掉开头的 / 后按原样当 zip 路径
  const dangling = Array.from(doc.getElementsByTagNameNS('*', 'Override')).filter(el => !zip.files[(el.getAttribute('PartName') || '').slice(1)]);
  if (!dangling.length) return buf;
  for (const el of dangling) el.remove();
  zip.file(TYPES_FILE, new XMLSerializer().serializeToString(doc));
  return zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' });
}
