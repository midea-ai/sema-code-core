import Anthropic from '@anthropic-ai/sdk'
import * as fs from 'fs'
import * as path from 'path'
import { readInitialCwd } from '../../util/cwd'
import { getSemaRootDir } from '../../util/savePath'
import { logError } from '../../util/log'
import { DESIGN_MODE_SYSTEM_REMINDER_PROMPT, ProjectDesignState } from '../../prompt/design/design'
import { getDesignManager } from '../design/designManager'

const DESIGN_MD_MAX_LINES = 500

/**
 * 扫描项目 .sema/design/ 下的现有产物，注入到 system reminder，避免 step 0 用 shell 探测
 */
function scanProjectDesignState(
  projectDesignRoot: string,
  projectDesignDoc: string,
  projectSkillsDir: string,
  projectCodeDir: string,
): ProjectDesignState {
  let designDocContent: string | null = null
  let designDocTruncated = false
  try {
    if (fs.existsSync(projectDesignDoc) && fs.statSync(projectDesignDoc).isFile()) {
      const raw = fs.readFileSync(projectDesignDoc, 'utf8')
      const lines = raw.split('\n')
      if (lines.length > DESIGN_MD_MAX_LINES) {
        designDocContent = lines.slice(0, DESIGN_MD_MAX_LINES).join('\n')
        designDocTruncated = true
      } else {
        designDocContent = raw
      }
    }
  } catch (error) {
    logError(`扫描 DESIGN.md 失败 [${projectDesignDoc}]: ${error}`)
  }

  const skillFolders: string[] = []
  try {
    if (fs.existsSync(projectSkillsDir)) {
      for (const entry of fs.readdirSync(projectSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) skillFolders.push(entry.name)
      }
      skillFolders.sort((a, b) => a.localeCompare(b))
    }
  } catch (error) {
    logError(`扫描 skills 目录失败 [${projectSkillsDir}]: ${error}`)
  }

  const codeEntries: Array<{ name: string, isDir: boolean }> = []
  try {
    if (fs.existsSync(projectCodeDir)) {
      for (const entry of fs.readdirSync(projectCodeDir, { withFileTypes: true })) {
        codeEntries.push({ name: entry.name, isDir: entry.isDirectory() })
      }
      codeEntries.sort((a, b) => a.name.localeCompare(b.name))
    }
  } catch (error) {
    logError(`扫描 code 目录失败 [${projectCodeDir}]: ${error}`)
  }

  // 已生成的图片清单：迭代时模型据此复用，避免重复生成
  const assetFiles: string[] = []
  const projectAssetsDir = path.join(projectCodeDir, 'assets')
  try {
    if (fs.existsSync(projectAssetsDir)) {
      for (const entry of fs.readdirSync(projectAssetsDir, { withFileTypes: true })) {
        if (entry.isFile()) assetFiles.push(entry.name)
      }
      assetFiles.sort((a, b) => a.localeCompare(b))
    }
  } catch (error) {
    logError(`扫描 assets 目录失败 [${projectAssetsDir}]: ${error}`)
  }

  return {
    designDocContent,
    designDocTruncated,
    designDocPath: projectDesignDoc,
    skillFolders,
    codeEntries,
    assetFiles,
  }
}

export function generateDesignReminders(): Anthropic.ContentBlockParam[] {
  const currentDir = readInitialCwd()
  const projectDesignRoot = path.join(currentDir, '.sema/design/')
  const projectSkillsDir = path.join(projectDesignRoot, 'skills/')
  const projectCodeDir = path.join(projectDesignRoot, 'code/')

  for (const dir of [projectSkillsDir, projectCodeDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (error) {
      logError(`预创建 design 目录失败 [${dir}]: ${error}`)
    }
  }

  const semaRoot = getSemaRootDir()
  const globalSkillsRoot = path.join(semaRoot, 'designs/skills')
  const globalDesignSystemsRoot = path.join(semaRoot, 'designs/design-systems')
  const projectDesignDoc = path.join(projectDesignRoot, 'DESIGN.md')

  const designManager = getDesignManager()
  const designSkills = designManager.listDesignSkills().map(s => ({
    folderName: s.folderName,
    description: s.description,
  }))
  const designSystems = designManager.listDesignSystems().map(s => s.folderName)

  const reminder = DESIGN_MODE_SYSTEM_REMINDER_PROMPT({
    projectDesignRoot,
    projectSkillsDir,
    projectDesignDoc,
    projectCodeDir,
    globalSkillsRoot,
    globalDesignSystemsRoot,
    designSkills,
    designSystems,
    projectState: scanProjectDesignState(
      projectDesignRoot,
      projectDesignDoc,
      projectSkillsDir,
      projectCodeDir,
    ),
  })

  return [{ type: 'text' as const, text: reminder }]
}
