# 文件读取工具 Read

读取文件内容，输出带行号的文本（cat -n 格式）。支持文本文件、Jupyter Notebook 和 PDF。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file_path` | `string` | ✓ | 文件绝对路径 |
| `offset` | `number` | — | 起始行号（从 1 开始） |
| `limit` | `number` | — | 读取行数 |

## 基本属性

- **isReadOnly**：`true`（可并发执行）
- **权限**：无需权限（受目录安全限制）


## 支持的文件类型

| 类型 | 说明 |
|------|------|
| 文本文件 | `.ts`、`.js`、`.py`、`.md`、`.json` 等 |
| Jupyter Notebook | `.ipynb`，返回所有 cell 内容（含输出） |
| PDF | `.pdf`，逐页提取文本和视觉内容 |


## 输出格式

文本文件以 `cat -n` 格式输出（带行号），方便后续 Edit 工具定位：

```
     1→import { z } from 'zod'
     2→import { Tool } from '../base/Tool'
     3→
     4→export const BashTool = {
     5→  name: 'Bash',
```


## 分段读取

超大文件建议分段读取：

```
# 读取第 100-200 行
file_path: "/path/to/large-file.ts"
offset: 100
limit: 100
```

单次读取上限：**0.25MB**（约 2000 行普通代码）。


## 文件时间戳

每次 Read 成功后，会记录该文件的修改时间戳。Edit 工具在执行前会验证此时间戳，确保文件内容没有在 Read 和 Edit 之间被外部修改。

因此，**Edit 工具操作之前必须先用 Read 读取文件**。


## 访问限制

文件访问受安全策略限制，只允许读取：
- 当前工作目录及其子目录
- 用户主目录（`~`）
- 临时目录（`/tmp`、`/var/tmp`）

尝试读取其他路径会返回错误提示。


## 使用示例

```
# 读取整个文件
file_path: "/project/src/core/SemaCore.ts"

# 读取 PDF
file_path: "/docs/design.pdf"

# 分段读取大文件
file_path: "/project/src/large-file.ts"
offset: 200
limit: 100

# 读取 Notebook
file_path: "/notebooks/analysis.ipynb"
```
