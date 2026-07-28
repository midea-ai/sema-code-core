export const TOOL_NAME_VIEW_FILE = 'view_file'
export const TOOL_NAME_RUN_SHELL = 'run_shell'
export const TOOL_NAME_PEEK_BG_JOB = 'peek_bg_job'
export const TOOL_NAME_STOP_BG_JOB = 'stop_bg_job'
export const TOOL_NAME_DEL_CRON = 'del_cron'
export const TOOL_NAME_LIST_CRONS = 'list_crons'
export const TOOL_NAME_CREATE_TODO = 'create_todo'
export const TOOL_NAME_LIST_TODOS = 'list_todos'
export const TOOL_NAME_GET_TODO = 'get_todo'
export const TOOL_NAME_UPDATE_TODO = 'update_todo'
export const TOOL_NAME_CREATE_CRON = 'create_cron'
export const TOOL_NAME_PICK_OPTION = 'ask_form'
export const TOOL_NAME_PLAN_TO_AGENT = 'plan_to_agent'
export const TOOL_NAME_FETCH_URL = 'fetch_url'
export const TOOL_NAME_SEARCH_FILES = 'search_files'
export const TOOL_NAME_SEARCH_CONTENT = 'search_content'
export const TOOL_NAME_EDIT_NOTEBOOK = 'edit_notebook'
export const TOOL_NAME_SKILL = 'skill'
export const TOOL_NAME_SUB_AGENT = 'sub_agent'
export const TOOL_NAME_WRITE_FILE = 'write_file'
export const TOOL_NAME_PATCH_FILE = 'patch_file'
export const TOOL_NAME_LOAD_TOOLS = 'load_tools'

// 工具搜索模式下默认加载的内置工具集（toolSearchDefaultTools 未配置时使用）
export const TOOL_SEARCH_DEFAULT_TOOLS = [
  TOOL_NAME_RUN_SHELL,
  TOOL_NAME_SEARCH_FILES,
  TOOL_NAME_SEARCH_CONTENT,
  TOOL_NAME_VIEW_FILE,
  TOOL_NAME_WRITE_FILE,
  TOOL_NAME_PATCH_FILE,
  TOOL_NAME_SUB_AGENT,
  TOOL_NAME_SKILL,
  TOOL_NAME_PICK_OPTION,
  TOOL_NAME_PLAN_TO_AGENT,
]
