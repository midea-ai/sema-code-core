/**
 * 会话记录（transcript）：只供 hook 脚本读取的追加式 JSONL，core 只写不读，永远不从它恢复会话。
 *
 * - 与历史 JSON 同目录、同主干名，扩展名 .jsonl；子代理为 <主干>.agent-<agentId>.jsonl
 * - 每行一条消息，只放通用字段 type / uuid / parentUuid / timestamp / sessionId / cwd / message，
 *   压缩摘要行多一个 isCompactSummary；图片块替换为占位文本，不写 base64
 * - 只追加不回改：游标是"已写 uuid 集合"，内存里 uuid 未写过的消息按内存顺序追加。
 *   压缩后保留的消息 uuid 已写过被跳过，只追加摘要行；微压缩原地改写不体现在文件里
 * - 门控：拿到 transcript_path 的四个事件（Stop / PreCompact / SubagentStart / SubagentStop）
 *   任一配置了 hook 才写，没配的用户零开销；每次 sync 时判断，中途刷新配置即生效
 * - 懒创建：首次有未写消息时建文件并用当时内存历史补种；恢复会话若已有文件则把当前内存消息视为已写
 * - 不随会话结束删除，退场跟随历史 JSON（history.ts 删 .json 时顺带删同主干 .jsonl）
 * - 加密：传了 encryption 时文件名带 .enc、每行一条密文（hook 程序收到的 transcript_path 就是密文路径）；
 *   首次写密文时删掉同主干的旧明文
 */

import * as fs from 'fs';
import * as path from 'path';
import { Message } from '../types/message';
import { MAIN_AGENT_ID } from '../manager/StateManager';
import { getHooksManager } from '../services/hooks/hooksManager';
import { resolveHistoryFile } from './history';
import { getHistoryFilePath } from './savePath';
import { readInitialCwd } from './cwd';
import { logWarn } from './log';
import { isEncName, sealLine, secureName, stripEnc } from './cipher';

// 带 transcript_path 的事件：任一配置了 hook 即开启写入
const TRANSCRIPT_EVENTS = ['Stop', 'PreCompact', 'SubagentStart', 'SubagentStop'];

const IMAGE_PLACEHOLDER = '[image omitted]';

// 压缩摘要消息标记（按对象标识，不给 Message 加字段，历史 JSON 不受影响）
const compactSummaries = new WeakSet<Message>();

/** 标记一条消息为压缩摘要，写入 transcript 时加 isCompactSummary */
export function markCompactSummary(message: Message): void {
  compactSummaries.add(message);
}

/** 是否开启 transcript 写入：带 transcript_path 的事件任一有可执行 hook 条目 */
export function isTranscriptEnabled(): boolean {
  const manager = getHooksManager();
  return TRANSCRIPT_EVENTS.some(event => manager.getMatchedEntries(event).length > 0);
}

/** 图片块替换为占位文本（含 tool_result 内嵌的图片），其余原样 */
function stripImages(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map(block => {
    if (!block || typeof block !== 'object') return block;
    if (block.type === 'image') return { type: 'text', text: IMAGE_PLACEHOLDER };
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      return { ...block, content: stripImages(block.content) };
    }
    return block;
  });
}

function serializeLine(message: Message, parentUuid: string | null, sessionId: string, cwd: string): string {
  const line: Record<string, unknown> = {
    type: message.type,
    uuid: message.uuid,
    parentUuid,
    timestamp: new Date().toISOString(),
    sessionId,
    cwd,
  };
  if (compactSummaries.has(message)) line.isCompactSummary = true;
  line.message = { ...message.message, content: stripImages(message.message.content) };
  // 有密钥时整条 JSON 变成一行密文
  return sealLine(JSON.stringify(line)) + '\n';
}

interface AgentCursor {
  written: Set<string>;
  lastUuid: string | null;
}

/**
 * 单个会话的 transcript 写入器（随 SessionRuntime 持有），按 agentId 各持一个游标
 */
export class TranscriptWriter {
  // 历史文件主干（不含扩展名），首次解析后缓存，会话内不变
  private stem: string | null = null;
  private cursors = new Map<string, AgentCursor>();

  constructor(private readonly sessionId: string) {}

  /** transcript 文件路径（可选子代理，开启加密时带 .enc）；文件不一定已创建 */
  getPath(projectPath: string | undefined, noDate: boolean, agentId: string = MAIN_AGENT_ID): string {
    const stem = this.resolveStem(projectPath, noDate);
    return secureName(agentId === MAIN_AGENT_ID ? `${stem}.jsonl` : `${stem}.agent-${agentId}.jsonl`);
  }

  /**
   * 把内存消息里尚未写入的追加到文件；门控未开启或无消息时直接返回。
   * 写失败只告警，失败的消息不入游标，下次 sync 重试。
   */
  sync(agentId: string, messages: Message[], projectPath: string | undefined, noDate: boolean): void {
    if (messages.length === 0 || !isTranscriptEnabled()) return;
    try {
      const filePath = this.getPath(projectPath, noDate, agentId);
      let cursor = this.cursors.get(agentId);
      if (!cursor) {
        cursor = { written: new Set(), lastUuid: null };
        this.cursors.set(agentId, cursor);
        // 恢复的会话已有文件：当前内存消息视为已写，之后只追加新增（不读文件内容）
        if (fs.existsSync(filePath)) {
          for (const message of messages) cursor.written.add(message.uuid);
          cursor.lastUuid = messages[messages.length - 1].uuid;
          return;
        }
      }

      const pending: Message[] = [];
      const lines: string[] = [];
      const cwd = projectPath || readInitialCwd();
      let parentUuid = cursor.lastUuid;
      for (const message of messages) {
        if (cursor.written.has(message.uuid)) continue;
        lines.push(serializeLine(message, parentUuid, this.sessionId, cwd));
        pending.push(message);
        parentUuid = message.uuid;
      }
      if (pending.length === 0) return;

      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // 首次写密文时清掉升级前留下的同主干明文
      if (isEncName(filePath) && !fs.existsSync(filePath)) {
        const plain = stripEnc(filePath);
        if (fs.existsSync(plain)) fs.unlinkSync(plain);
      }
      fs.appendFileSync(filePath, lines.join(''));
      for (const message of pending) cursor.written.add(message.uuid);
      cursor.lastUuid = parentUuid;
    } catch (error) {
      logWarn(`写入会话记录失败 ${this.sessionId}/${agentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 子代理结束时丢弃其游标（文件保留） */
  dropAgent(agentId: string): void {
    this.cursors.delete(agentId);
  }

  /** 与 saveHistory 同口径：已有历史文件沿用其名，否则按 noDate 取新文件名 */
  private resolveStem(projectPath: string | undefined, noDate: boolean): string {
    if (!this.stem) {
      const resolved = resolveHistoryFile(this.sessionId, projectPath);
      // 历史文件可能是 .json.enc，主干按明文名取
      const jsonPath = stripEnc(resolved.exists ? resolved.path : getHistoryFilePath(this.sessionId, projectPath, noDate));
      this.stem = jsonPath.slice(0, -'.json'.length);
    }
    return this.stem;
  }
}
