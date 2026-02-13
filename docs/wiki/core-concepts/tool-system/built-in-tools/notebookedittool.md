# 笔记本编辑工具 NotebookEdit

编辑 Jupyter Notebook（`.ipynb`）文件中的单元格，支持替换、插入和删除操作。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `notebook_path` | `string` | ✓ | `.ipynb` 文件绝对路径 |
| `cell_number` | `number` | ✓ | 目标单元格的索引（0-based） |
| `new_source` | `string` | ✓ | 单元格的新内容 |
| `cell_type` | `string` | — | 单元格类型：`code` 或 `markdown`；使用 `insert` 模式时必填 |
| `edit_mode` | `string` | — | 操作模式：`replace`（默认）、`insert`、`delete` |

## 基本属性

- **isReadOnly**：`false`（串行执行）
- **权限**：受 `skipFileEditPermission` 控制（默认跳过）


## 操作模式

### replace（替换，默认）

替换指定 `cell_number` 的单元格内容，同时清空执行计数和输出结果：

```
notebook_path: "/notebooks/analysis.ipynb"
cell_number: 2
new_source: "import pandas as pd\nimport numpy as np"
edit_mode: "replace"
```

### insert（插入）

在指定 `cell_number` 位置插入新单元格（原有单元格依次后移）。`cell_type` 为必填项：

```
notebook_path: "/notebooks/analysis.ipynb"
cell_number: 3
cell_type: "markdown"
new_source: "## 数据分析\n\n以下对数据进行探索性分析。"
edit_mode: "insert"
```

### delete（删除）

删除指定 `cell_number` 的单元格（`new_source` 可传空字符串）：

```
notebook_path: "/notebooks/analysis.ipynb"
cell_number: 2
new_source: ""
edit_mode: "delete"
```


## 使用建议

- 编辑前先用 Read 工具读取 Notebook，了解单元格索引和结构
- `cell_number` 从 0 开始计数；`insert` 模式下最大值为当前单元格总数（表示追加到末尾）
- 每次只修改一个单元格，避免大范围修改导致难以追踪
- 修改代码单元格后，需要在 Jupyter 环境中重新运行才能更新输出
