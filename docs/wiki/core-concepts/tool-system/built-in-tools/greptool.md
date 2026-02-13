# 文本搜索工具 Grep

用正则表达式搜索文件内容，底层基于 ripgrep，支持丰富的过滤和输出选项。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pattern` | `string` | ✓ | 正则表达式搜索模式 |
| `path` | `string` | — | 搜索路径（文件或目录），默认工作目录 |
| `glob` | `string` | — | 文件 glob 过滤，如 `*.ts`、`**/*.{ts,tsx}` |
| `type` | `string` | — | 文件类型：`js`、`ts`、`py`、`rust`、`go` 等 |
| `output_mode` | `string` | — | 输出模式（见下方） |
| `-i` | `boolean` | — | 大小写不敏感，默认 false |
| `-n` | `boolean` | — | 显示行号，默认 true（content 模式） |
| `-C` | `number` | — | 匹配行前后各显示 N 行 |
| `-A` | `number` | — | 匹配行后显示 N 行 |
| `-B` | `number` | — | 匹配行前显示 N 行 |
| `multiline` | `boolean` | — | 多行模式（`.` 匹配换行符），默认 false |
| `head_limit` | `number` | — | 限制结果数量（类似 `\| head -N`） |
| `offset` | `number` | — | 跳过前 N 个结果 |

## 基本属性

- **isReadOnly**：`true`（可并发执行）
- **权限**：无需权限


## 输出模式

| `output_mode` | 返回内容 | 适用场景 |
|---------------|---------|---------|
| `files_with_matches`（默认）| 包含匹配的文件路径列表，按修改时间倒序排列 | 快速定位文件 |
| `content` | 匹配行的完整内容（含行号） | 查看具体代码 |
| `count` | 每个文件的匹配数量 | 统计分析 |


## 使用示例

```
# 查找所有包含 SemaCore 的文件（默认模式）
pattern: "SemaCore"
glob: "*.ts"

# 查看具体匹配内容（含上下文）
pattern: "class SemaCore"
output_mode: "content"
-C: 3

# 大小写不敏感搜索
pattern: "todo|fixme|hack"
output_mode: "content"
-i: true
glob: "**/*.ts"

# 搜索多行模式（跨行匹配）
pattern: "interface\\s+\\w+\\s*\\{[\\s\\S]*?\\}"
multiline: true
type: "ts"

# 搜索并限制结果数量
pattern: "import.*from"
output_mode: "files_with_matches"
head_limit: 10
```


## 正则语法

Grep 使用 ripgrep 的正则语法（Rust regex crate）：

| 语法 | 含义 |
|------|------|
| `\d+` | 一个或多个数字 |
| `\w+` | 单词字符 |
| `\s+` | 空白字符 |
| `(?i)` | 内嵌大小写不敏感标志 |
| `\{` | 字面量 `{`（需转义） |
| `(a\|b)` | 匹配 a 或 b |


## 使用建议

- 搜索类定义、函数用 `output_mode: "content"` 查看具体代码
- 大范围扫描用默认的 `files_with_matches`，找到文件后再用 Read 读取；结果按修改时间倒序排列，最新改动的文件优先显示
- 配合 `type` 参数过滤文件类型比 `glob` 更简洁高效
- 返回给助手的结果最多 100 条，超出时会提示使用更精确的路径或模式
