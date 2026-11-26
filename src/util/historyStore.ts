import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Message } from '../types/message';
import type { HistoryData } from './history';
import { openLine, sealLine, secureName, resolveSecurePath, stripEnc, isEncName } from './cipher';
import { SemaError } from './errors';

export interface HistoryMeta extends Omit<HistoryData, 'messages' | 'goal'> {
  version: 2;
  sessionId: string;
  revision: number;
  historyEpoch: number;
  committedBytes: number;
  messageCount: number;
  lastMessageUuid: string | null;
  updatedAt: number;
  goal: HistoryData['goal'] | null;
}

interface InstallFile { source: string; target: string }
interface Rewrite { version: 1; sessionId: string; files: InstallFile[]; cleanup: string[] }

/** Fault injection at persistence boundaries; unused in production. */
export const __historyTestHooks: { afterStep?: (step: string) => void; beforeLockReclaim?: (file: string) => void } = {};
const step = (name: string) => __historyTestHooks.afterStep?.(name);
const corrupt = (message: string): never => { throw new SemaError('HISTORY_CORRUPT', message); };

export function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    // Windows does not expose directory fsync through Node's filesystem API.
    if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writeSynced(file: string, data: Buffer | string): void {
  const fd = fs.openSync(file, 'w', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(sealLine(JSON.stringify(value)) + '\n');
}

function decodeJson(file: string): any {
  const raw = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(isEncName(file) ? openLine(raw).toString('utf8') : raw); }
  catch (error) {
    if (error instanceof SemaError) throw error;
    return corrupt(`Invalid history JSON: ${file}`);
  }
}

function encodeMessage(message: Message): Buffer {
  return Buffer.from(sealLine(JSON.stringify(message)) + '\n');
}

/**
 * 逐条写入，返回写入字节数。
 * 不先把历史拼成整份字符串：峰值内存只到单条消息，代价是多几次系统调用。
 */
function writeMessages(fd: number, messages: Message[], position: number): number {
  let offset = position;
  for (const message of messages) {
    const line = encodeMessage(message);
    let written = 0;
    while (written < line.length) {
      const n = fs.writeSync(fd, line, written, line.length - written, offset + written);
      if (!n) throw new Error('History write made no progress');
      written += n;
    }
    offset += line.length;
  }
  return offset - position;
}

function validateMessage(value: any): asserts value is Message {
  if (!value || !['user', 'assistant'].includes(value.type) || typeof value.uuid !== 'string' || !value.message) corrupt('Invalid history message');
}

function validateMeta(meta: any, sessionId: string): asserts meta is HistoryMeta {
  if (meta?.version !== 2) corrupt('Unsupported history format version');
  if (meta.sessionId !== sessionId || !Array.isArray(meta.todos)) corrupt('Invalid history metadata');
  for (const key of ['revision', 'historyEpoch', 'committedBytes', 'messageCount']) {
    if (!Number.isSafeInteger(meta[key]) || meta[key] < (key === 'revision' || key === 'historyEpoch' ? 1 : 0)) corrupt(`Invalid history ${key}`);
  }
  if (meta.messageCount === 0 ? meta.lastMessageUuid !== null : typeof meta.lastMessageUuid !== 'string') corrupt('Invalid last message UUID');
}

function parseMessageLine(line: Buffer, encrypted: boolean): Message {
  try {
    const value = JSON.parse(encrypted ? openLine(line.toString('utf8')).toString('utf8') : line.toString('utf8'));
    validateMessage(value);
    return value;
  } catch (error) {
    if (error instanceof SemaError) throw error;
    return corrupt('Invalid committed history line');
  }
}

const READ_CHUNK_BYTES = 1 << 20;

/**
 * 按行流式读取已提交区间：峰值内存只到单行加一个读块，
 * 不把整份历史先读成字符串再 split（那会同时留下 buffer、整串和行数组）。
 * 跨块的行只在遇到换行时拼一次，不每块都把整条未完成的行重拼一遍——
 * 否则一条几 MB 的消息（例如带多张 base64 图片）会让读取开销随消息大小平方增长。
 */
function readMessages(file: string, bytes: number, encrypted: boolean): Message[] {
  const fd = fs.openSync(file, 'r');
  try {
    if (fs.fstatSync(fd).size < bytes) corrupt('History is shorter than its committed boundary');
    const messages: Message[] = [];
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let fragments: Buffer[] = [];
    let consumed = 0;
    while (consumed < bytes) {
      const n = fs.readSync(fd, chunk, 0, Math.min(READ_CHUNK_BYTES, bytes - consumed), consumed);
      if (!n) corrupt('History ended before its committed boundary');
      consumed += n;
      const view = chunk.subarray(0, n);
      let start = 0;
      for (let end = view.indexOf(10, start); end !== -1; end = view.indexOf(10, start)) {
        const tail = view.subarray(start, end);
        messages.push(parseMessageLine(fragments.length === 0 ? tail : Buffer.concat([...fragments, tail]), encrypted));
        fragments = [];
        start = end + 1;
      }
      if (start < n) fragments.push(Buffer.from(view.subarray(start)));
    }
    if (fragments.length > 0) corrupt('History boundary is not a complete line');
    return messages;
  } finally { fs.closeSync(fd); }
}

function atomicJson(plain: string, data: unknown): void {
  const target = secureName(plain);
  const temp = secureName(`${plain.slice(0, -'.meta.json'.length)}.txn-${randomUUID()}.tmp`);
  try {
    writeSynced(temp, encodeJson(data));
    fs.renameSync(temp, target);
    syncDirectory(path.dirname(target));
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function readOrNull(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** 锁内容里的属主还在：读不出内容（空文件、写了一半）或 pid 非法都算已退出 */
function lockOwnerAlive(raw: string | null): boolean {
  if (raw === null) return false;
  let pid: unknown;
  try { pid = JSON.parse(raw)?.pid; } catch { return false; }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/**
 * 原子发布锁：内容先写进同目录的临时文件，再用硬链接把它变成锁名。
 * 锁名出现时内容一定完整——进程在发布途中退出不会留下无法判断属主的空锁。
 * 锁已被别人发布时抛 EEXIST。硬链接是互斥的唯一来源，不支持的文件系统明确失败，
 * 不退回"先建后写"——那个窗口里两个写入者会同时认为自己持锁。
 */
function publishLock(file: string, token: string): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temp, file); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') throw error;
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'].includes(code)) {
        throw new SemaError('HISTORY_WRITE_FAILED', `History locking needs hard links, unsupported at ${path.dirname(file)} (${code})`);
      }
      throw error;
    }
  } finally { fs.rmSync(temp, { force: true }); }
}

/**
 * 回收属主已退出的锁，返回锁是否已不构成阻塞。
 * 删除必须在"回收凭据"（同名 .reclaim）保护下进行：持凭据期间锁名一直存在，
 * 别的进程既发布不了新锁也回收不了，所以校验内容和删除之间不会被接替者插进来。
 * 凭据本身也是锁，崩溃后按同一协议在下一层 .reclaim 保护下回收；
 * 不能先移走再校验，否则可能把刚接替的活跃凭据移开，暴露无保护窗口。
 */
function reclaimLock(file: string): boolean {
  const raw = readOrNull(file);
  if (raw === null) return true;
  if (lockOwnerAlive(raw)) return false;
  const guard = file + '.reclaim';
  const token = tryLockFile(guard);
  if (!token) return false;
  try {
    __historyTestHooks.beforeLockReclaim?.(file);
    // 内容变了说明拿到凭据之前已被接替，锁归他
    if (readOrNull(file) !== raw) return false;
    fs.unlinkSync(file);
    return true;
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  finally { releaseLock(guard, token); }
}

/** 主锁与回收凭据共用同一套互斥和崩溃恢复协议。 */
function tryLockFile(file: string): string | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = randomUUID();
    try { publishLock(file, token); return token; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!reclaimLock(file)) return null;
    }
  }
  return null;
}

/** 取得主干的写入锁，返回令牌；有活跃写入者时返回 null（陈旧锁先回收再重试一次）。 */
export function tryLockHistory(stem: string): string | null {
  return tryLockFile(stem + '.lock');
}

/** 释放自己发布的锁；令牌对不上（已被回收重建）时不动别人的锁。 */
export function releaseLock(file: string, token: string): void {
  try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); }
  catch { /* 已不存在，或内容已被别人接管 */ }
}

/** One writer per logical history; messages already committed must be immutable. */
export class HistoryStore {
  private meta: HistoryMeta | null = null;
  private committed: Message[] = [];
  private metadataJson = '';
  private initialized = false;
  private encrypted = false;
  private lockToken: string | null = null;
  private needsReload = false;
  private pendingMessages?: Message[];
  private agents = new Map<string, { messages: Message[]; bytes: number }>();
  private retiredAgents = new Set<string>();
  private closed = false;

  constructor(readonly stem: string, readonly sessionId: string) {}

  private lock(): void {
    if (this.closed) throw new SemaError('HISTORY_BUSY', 'History writer has been closed');
    if (this.lockToken) return;
    fs.mkdirSync(path.dirname(this.stem), { recursive: true });
    const token = tryLockHistory(this.stem);
    if (!token) throw new SemaError('HISTORY_BUSY', `History is already open: ${this.sessionId}`);
    this.lockToken = token;
  }

  close(): void {
    this.closed = true;
    if (!this.lockToken) return;
    releaseLock(this.stem + '.lock', this.lockToken);
    this.lockToken = null;
  }

  get messagePath(): string { return secureName(this.stem + '.jsonl'); }

  private local(name: string): string {
    if (path.basename(name) !== name || !name.startsWith(path.basename(this.stem) + '.')) corrupt('Invalid rewrite path');
    return path.join(path.dirname(this.stem), name);
  }

  private recover(): void {
    const resolved = resolveSecurePath(this.stem + '.rewrite.json');
    if (!resolved.exists) return;
    const txn = decodeJson(resolved.path) as Rewrite;
    if (txn.version !== 1 || txn.sessionId !== this.sessionId || !Array.isArray(txn.files) || txn.files.length !== 2 || !Array.isArray(txn.cleanup)) corrupt('Invalid rewrite transaction');
    const expected = [this.stem + '.jsonl', this.stem + '.meta.json'];
    txn.files.forEach((file, index) => {
      const source = this.local(file.source), target = this.local(file.target);
      if (stripEnc(target) !== expected[index] || !stripEnc(source).endsWith('.tmp')) corrupt('Unexpected rewrite target');
      // 事务标记出现在临时文件写完之后，所以"临时文件还在"就等价于"这一步没安装"，
      // 按存在性直接改名即可：不再把整份历史读回来做内容校验
      if (fs.existsSync(source)) {
        fs.renameSync(source, target);
        syncDirectory(path.dirname(this.stem));
      } else if (!fs.existsSync(target)) corrupt('Missing rewrite material');
      step(index === 0 ? 'rewrite:messages' : 'rewrite:meta');
    });
    const allowedCleanup = [this.stem + '.json', this.stem + '.json.enc', this.stem + '.jsonl', this.stem + '.meta.json'];
    for (const name of txn.cleanup) {
      const file = this.local(name);
      if (!allowedCleanup.includes(file) || txn.files.some(f => this.local(f.target) === file)) corrupt('Invalid rewrite cleanup');
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    for (const file of txn.files) {
      const source = this.local(file.source);
      if (fs.existsSync(source)) fs.unlinkSync(source);
    }
    fs.unlinkSync(resolved.path);
    syncDirectory(path.dirname(this.stem));
  }

  load(): HistoryData {
    this.lock();
    this.recover();
    // A crash while staging a rewrite or a lock leaves only disposable temp files.
    const prefix = path.basename(this.stem) + '.';
    for (const file of fs.readdirSync(path.dirname(this.stem))) {
      const plain = stripEnc(file);
      if (plain.startsWith(prefix) && plain.endsWith('.tmp')) fs.unlinkSync(path.join(path.dirname(this.stem), file));
    }
    const resolved = resolveSecurePath(this.stem + '.meta.json');
    let data: HistoryData;
    if (resolved.exists) {
      const meta = decodeJson(resolved.path);
      validateMeta(meta, this.sessionId);
      const file = this.stem + '.jsonl' + (resolved.encrypted ? '.enc' : '');
      if (!fs.existsSync(file)) corrupt('Missing committed messages file');
      const messages = readMessages(file, meta.committedBytes, resolved.encrypted);
      if (messages.length !== meta.messageCount || (messages[messages.length - 1]?.uuid ?? null) !== meta.lastMessageUuid) corrupt('History metadata does not match messages');
      this.meta = meta;
      this.encrypted = resolved.encrypted;
      data = { messages, todos: meta.todos, todoTasks: meta.todoTasks, readFileTimestamps: meta.readFileTimestamps, ...(meta.goal && { goal: meta.goal }) };
    } else {
      const legacy = resolveSecurePath(this.stem + '.json');
      this.meta = null;
      if (legacy.exists) {
        data = decodeJson(legacy.path);
        if (!Array.isArray(data.messages)) corrupt('Invalid legacy history');
        data.messages.forEach(validateMessage);
        data.todos ??= [];
      } else {
        if (resolveSecurePath(this.stem + '.jsonl').exists) corrupt('Orphan JSONL without metadata or legacy history');
        data = { messages: [], todos: [] };
      }
    }
    this.committed = data.messages.slice();
    this.metadataJson = JSON.stringify(this.state(data));
    this.initialized = true;
    this.needsReload = false;
    return data;
  }

  private state(data: HistoryData) {
    return { todos: data.todos ?? [], todoTasks: data.todoTasks ?? [], readFileTimestamps: data.readFileTimestamps ?? {}, goal: data.goal ?? null };
  }

  save(data: HistoryData, replace = false): void {
    this.lock();
    if (this.needsReload && resolveSecurePath(this.stem + '.rewrite.json').exists && this.pendingMessages !== data.messages) {
      throw new SemaError('HISTORY_BUSY', 'Reload history before changing a pending rewrite');
    }
    if (!this.initialized || this.needsReload) this.load();
    // Reference comparison catches same-length/same-UUID microcompact without
    // serializing old bodies. Persisted messages are immutable by contract.
    const append = !replace && !!this.meta && this.encrypted === isEncName(this.messagePath)
      && this.committed.length <= data.messages.length
      && this.committed.every((message, i) => message === data.messages[i]);
    const state = this.state(data);
    const stateJson = JSON.stringify(state);
    const pending = append ? data.messages.slice(this.committed.length) : data.messages;
    if (append && !pending.length && stateJson === this.metadataJson) return;
    const base = append ? this.meta!.committedBytes : 0;
    const meta: HistoryMeta = {
      ...state, version: 2, sessionId: this.sessionId,
      revision: (this.meta?.revision ?? 0) + 1,
      historyEpoch: (this.meta?.historyEpoch ?? 0) + (append ? 0 : 1),
      committedBytes: base,
      messageCount: data.messages.length,
      lastMessageUuid: data.messages[data.messages.length - 1]?.uuid ?? null,
      updatedAt: Date.now(),
    };
    this.pendingMessages = data.messages;
    try {
      if (append) {
        if (pending.length > 0) {
          const fd = fs.openSync(this.messagePath, 'r+');
          try {
            if (fs.fstatSync(fd).size < base) corrupt('History is shorter than its committed boundary');
            fs.ftruncateSync(fd, base);
            meta.committedBytes = base + writeMessages(fd, pending, base);
            fs.fsyncSync(fd);
          } finally { fs.closeSync(fd); }
        }
        step('append:messages');
        atomicJson(this.stem + '.meta.json', meta);
        step('append:meta');
      } else {
        this.rewrite(pending, meta);
      }
      this.meta = meta;
      this.encrypted = isEncName(this.messagePath);
      this.committed = data.messages.slice();
      this.metadataJson = stateJson;
      this.pendingMessages = undefined;
    } catch (error) {
      this.needsReload = true;
      throw error;
    }
  }

  private rewrite(messages: Message[], meta: HistoryMeta): void {
    const prefix = `${this.stem}.txn-${randomUUID()}`;
    const messageTemp = secureName(prefix + '.messages.tmp');
    const metaTemp = secureName(prefix + '.meta.tmp');
    const fd = fs.openSync(messageTemp, 'w', 0o600);
    try {
      meta.committedBytes = writeMessages(fd, messages, 0);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const metaBytes = encodeJson(meta);
    writeSynced(metaTemp, metaBytes);
    const files = [[messageTemp, this.messagePath], [metaTemp, secureName(this.stem + '.meta.json')]] as const;
    const txn: Rewrite = {
      version: 1, sessionId: this.sessionId,
      files: files.map(([source, target]) => ({ source: path.basename(source), target: path.basename(target) })),
      cleanup: [this.stem + '.json', this.stem + '.json.enc', ...(isEncName(this.messagePath) ? [this.stem + '.jsonl', this.stem + '.meta.json'] : [])].map(f => path.basename(f)),
    };
    const marker = secureName(this.stem + '.rewrite.json');
    const markerTemp = secureName(prefix + '.intent.tmp');
    writeSynced(markerTemp, encodeJson(txn));
    fs.renameSync(markerTemp, marker);
    syncDirectory(path.dirname(this.stem));
    step('rewrite:intent');
    this.recover();
  }

  agentPath(agentId: string): string {
    if (!agentId || path.basename(agentId) !== agentId || agentId === '.' || agentId === '..' || /[\\/]/.test(agentId)) throw new Error('Invalid agent ID');
    return secureName(path.join(this.stem, agentId + '.jsonl'));
  }

  saveAgent(agentId: string, messages: Message[]): void {
    if (!messages.length || this.retiredAgents.has(agentId) || this.closed) return;
    this.lock();
    const file = this.agentPath(agentId);
    fs.mkdirSync(this.stem, { recursive: true });
    const previous = this.agents.get(agentId);
    const append = previous && previous.messages.length <= messages.length && previous.messages.every((m, i) => m === messages[i]);
    if (append && previous.messages.length === messages.length) return;
    let written = 0;
    if (append) {
      const fd = fs.openSync(file, 'r+');
      try {
        fs.ftruncateSync(fd, previous.bytes);
        written = writeMessages(fd, messages.slice(previous.messages.length), previous.bytes);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    } else {
      const temp = file + '.' + randomUUID() + '.tmp';
      try {
        const fd = fs.openSync(temp, 'w', 0o600);
        try { written = writeMessages(fd, messages, 0); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temp, file);
        syncDirectory(this.stem);
      } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    }
    if (this.meta && !this.needsReload) {
      const touched = { ...this.meta, revision: this.meta.revision + 1, updatedAt: Date.now() };
      try { atomicJson(this.stem + '.meta.json', touched); }
      catch (error) { this.needsReload = true; throw error; }
      this.meta = touched;
    }
    this.agents.set(agentId, { messages: messages.slice(), bytes: (append ? previous.bytes : 0) + written });
  }

  retireAgent(agentId: string): void { this.agents.delete(agentId); this.retiredAgents.add(agentId); }

  clearAgents(defer: (remove: () => void) => void = remove => remove()): void {
    for (const id of this.agents.keys()) this.retiredAgents.add(id);
    this.agents.clear();
    const files = fs.existsSync(this.stem) ? fs.readdirSync(this.stem) : [];
    defer(() => {
      for (const file of files) fs.rmSync(path.join(this.stem, file), { force: true });
      if (fs.existsSync(this.stem) && fs.readdirSync(this.stem).length === 0) fs.rmdirSync(this.stem);
    });
  }
}
