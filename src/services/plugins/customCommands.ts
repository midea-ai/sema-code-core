/**
 * 自定义 Slash Commands 加载和管理模块
 */

import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { CustomCommand, LoadCustomCommandsResult, CustomCommandFrontmatter } from '../../types/command';
import { parseMarkdownWithFrontmatter } from '../../util/frontmatter';
import { getSemaRootDir } from '../../util/savePath';
import { getOriginalCwd } from '../../util/cwd';
import { normalizeFilePath } from '../../util/file';
import { logDebug, logWarn } from '../../util/log';

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile);
const access = promisify(fs.access);

/**
 * 命令缓存
 */
let cachedCommands: CustomCommand[] | null = null;

/**
 * 获取自定义命令目录
 */
export function getCustomCommandDirectories(): {
  projectCommands: string;
  userCommands: string;
} {
  const projectDir = getOriginalCwd();
  const userDir = getSemaRootDir();

  return {
    projectCommands: path.join(projectDir, '.sema', 'commands'),
    userCommands: path.join(userDir, 'commands'),
  };
}

/**
 * 检查目录是否存在
 */
async function directoryExists(dir: string): Promise<boolean> {
  try {
    await access(dir, fs.constants.R_OK);
    const stats = await stat(dir);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 从文件路径生成命令名
 * 例如：frontend/test.md → frontend:test
 */
function generateCommandName(filePath: string, baseDir: string): string {
  const relativePath = path.relative(baseDir, filePath);
  const withoutExt = relativePath.replace(/\.md$/i, '');

  // 将路径分隔符替换为冒号
  return withoutExt.split(path.sep).join(':');
}

/**
 * 解析命令文件
 */
async function parseCommandFile(
  filePath: string,
  baseDir: string,
  scope: 'user' | 'project'
): Promise<CustomCommand | null> {
  try {
    const fileContent = await readFile(filePath, 'utf-8');
    const { metadata, body } = parseMarkdownWithFrontmatter(fileContent);

    const frontmatter = metadata as CustomCommandFrontmatter;
    const name = generateCommandName(filePath, baseDir);

    return {
      name,
      displayName: `/${name}`,
      description: frontmatter.description || 'No description',
      argumentHint: frontmatter['argument-hint'],
      filePath: normalizeFilePath(filePath),
      scope,
      content: body.trim(),
    };
  } catch (error) {
    logWarn(`Failed to parse command file ${filePath}: ${error}`);
    return null;
  }
}

/**
 * 递归扫描目录中的所有 .md 文件
 */
async function scanCommandFiles(
  directory: string,
  scope: 'user' | 'project'
): Promise<CustomCommand[]> {
  const commands: CustomCommand[] = [];
  const errors: Array<{ file: string; error: string }> = [];

  async function scan(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // 递归扫描子目录
          await scan(fullPath);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          // 解析 .md 文件
          const command = await parseCommandFile(fullPath, directory, scope);
          if (command) {
            commands.push(command);
          } else {
            errors.push({
              file: fullPath,
              error: 'Failed to parse command file',
            });
          }
        }
      }
    } catch (error) {
      logWarn(`Failed to scan directory ${dir}: ${error}`);
    }
  }

  await scan(directory);
  return commands;
}

/**
 * 合并命令列表，按优先级去重
 * 优先级：用户级别 > 项目级别
 */
function mergeCommandsByPriority(
  userCommands: CustomCommand[],
  projectCommands: CustomCommand[]
): CustomCommand[] {
  const commandMap = new Map<string, CustomCommand>();

  // 先添加项目级别命令
  for (const cmd of projectCommands) {
    commandMap.set(cmd.name, cmd);
  }

  // 用户级别命令会覆盖同名项目命令
  for (const cmd of userCommands) {
    commandMap.set(cmd.name, cmd);
  }

  return Array.from(commandMap.values());
}

/**
 * 加载所有自定义命令
 */
export async function loadCustomCommands(): Promise<LoadCustomCommandsResult> {
  const dirs = getCustomCommandDirectories();
  const errors: Array<{ file: string; error: string }> = [];

  logDebug(`Loading custom commands from: ${JSON.stringify(dirs)}`);

  // 检查目录是否存在
  const [userDirExists, projectDirExists] = await Promise.all([
    directoryExists(dirs.userCommands),
    directoryExists(dirs.projectCommands),
  ]);

  // 并行扫描两个目录
  const [userCommands, projectCommands] = await Promise.all([
    userDirExists ? scanCommandFiles(dirs.userCommands, 'user') : Promise.resolve([]),
    projectDirExists ? scanCommandFiles(dirs.projectCommands, 'project') : Promise.resolve([]),
  ]);

  logDebug(`Loaded ${userCommands.length} user commands, ${projectCommands.length} project commands`);

  // 合并并去重
  const commands = mergeCommandsByPriority(userCommands, projectCommands);

  return { commands, errors };
}

/**
 * 获取缓存的自定义命令列表
 */
export async function getCachedCustomCommands(): Promise<CustomCommand[]> {
  if (!cachedCommands) {
    const result = await loadCustomCommands();
    cachedCommands = result.commands;

    if (result.errors.length > 0) {
      logWarn(`Custom command load errors: ${JSON.stringify(result.errors)}`);
    }
  }
  return cachedCommands;
}

/**
 * 重新加载自定义命令（清除缓存）
 */
export function reloadCustomCommands(): void {
  cachedCommands = null;
  logDebug('Custom commands cache cleared');
}

/**
 * 替换命令内容中的 $ARGUMENTS 占位符
 * 如果内容中没有 $ARGUMENTS，将参数追加到末尾
 */
export function resolveArguments(content: string, args: string): string {
  if (!args) {
    return content;
  }

  if (content.includes('$ARGUMENTS')) {
    return content.replace(/\$ARGUMENTS/g, args);
  }

  // 如果没有 $ARGUMENTS 占位符，追加到末尾
  return `${content}\n\n${args}`;
}
