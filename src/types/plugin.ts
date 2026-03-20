export type PluginScope = 'local' | 'project' | 'user'

export interface GithubSource {
  source: 'github'
  repo: string
}

export interface DirectorySource {
  source: 'directory'
  path: string
}

export type MarketplaceSource = GithubSource | DirectorySource

/** marketplace.json 中插件 source 为 url 时的结构 */
export interface PluginUrlSource {
  source: 'url'
  url: string
}

/** marketplace.json 中插件 source 字段类型：相对路径字符串 或 url 对象 */
export type PluginSource = string | PluginUrlSource

/** .claude-plugin/plugin.json 的结构 */
export interface PluginJson {
  name?: string
  version?: string
  [key: string]: any
}

/** known_marketplaces.json 中单个市场的结构 */
export interface KnownMarketplace {
  source: MarketplaceSource
  installLocation: string
  lastUpdated: string
}

/** known_marketplaces.json 文件结构 */
export interface KnownMarketplaces {
  [name: string]: KnownMarketplace
}

/** installed_plugins.json 中单个安装记录 */
export interface InstalledPluginEntry {
  scope: PluginScope
  projectPath?: string  // user scope 没有该字段
  installPath: string
  version: string
  installedAt: string
  lastUpdated: string
  gitCommitSha?: string
}

/** installed_plugins.json 文件结构 */
export interface InstalledPlugins {
  plugins: {
    [pluginKey: string]: InstalledPluginEntry[]  // key: "plugin@marketplace"
  }
}

/** marketplace.json 中的单个插件定义 */
export interface MarketplacePluginDef {
  name: string
  description: string
  version?: string        // 直接在 marketplace.json 中指定版本
  author?: { name: string; [key: string]: any }
  source: PluginSource    // 相对路径字符串 或 { source: 'url', url: '...' }
}

/** 市场安装路径下 .claude-plugin/marketplace.json 的结构 */
export interface MarketplaceJson {
  name: string
  plugins: MarketplacePluginDef[]
}

/** settings 文件中的 enabledPlugins 结构 */
export interface PluginSettings {
  enabledPlugins?: { [pluginKey: string]: boolean }
  [key: string]: any
}

/** 插件组件条目 */
export interface PluginComponentEntry {
  name: string
  filePath: string
}

/** 插件组件信息 */
export interface PluginComponents {
  commands: PluginComponentEntry[]
  agents: PluginComponentEntry[]
  skills: PluginComponentEntry[]
  mcp: PluginComponentEntry[]
}

/** 返回结果中的市场信息 */
export interface MarketplaceInfoResult {
  name: string
  source: {
    source: string
    repo?: string   // github 时有值
    path?: string   // directory 时有值
  }
  lastUpdated: string
  available: Array<{ name: string; description: string; author: string }>
  installed: string[]
  from: string
}

/** 返回结果中的插件信息 */
export interface PluginInfoResult {
  name: string
  marketplace: string
  scope: PluginScope
  status: boolean
  version: string
  description: string
  author: string
  components: PluginComponents
  from: string
}

/** getMarketplacePluginsInfo 的返回类型 */
export interface MarketplacePluginsInfo {
  marketplaces: MarketplaceInfoResult[]
  plugins: PluginInfoResult[]
}
