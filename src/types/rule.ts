export type RuleScope = 'user' | 'project'

export interface RuleConfig {
  prompt: string
  locate?: RuleScope
  from?: string
  filePath?: string
}
