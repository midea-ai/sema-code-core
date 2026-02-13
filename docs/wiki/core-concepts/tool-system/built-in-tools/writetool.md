# 文件写入工具 Write

创建新文件或覆盖已有文件的完整内容。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file_path` | `string` | ✓ | 目标文件绝对路径 |
| `content` | `string` | ✓ | 写入的文件内容 |

## 基本属性

- **isReadOnly**：`false`（串行执行）


## 行为说明

### 自动创建目录

目标文件的父目录不存在时，会自动递归创建：

```
file_path: "/project/src/new-module/index.ts"
→ 自动创建 /project/src/new-module/ 目录
```

### 已存在文件

覆盖已有文件时，**必须先用 Read 工具读取该文件**，否则工具会报错。这是为了防止意外覆盖未读取的文件。

此外，如果文件在读取之后被外部程序（用户或 linter 等）修改过，工具同样会报错，需要重新读取后再写入。

**创建全新文件**时无需先读取。

### 编码与行结尾保持

- **编码**：检测原文件编码（UTF-8、GBK 等），写入时保持原编码；新文件默认使用 UTF-8。
- **行结尾**：检测原文件行结尾格式（LF / CRLF），写入时保持一致；新文件则检测仓库默认行结尾。


## 使用场景

Write 适合以下场景：
- 创建全新文件
- 需要完全重写文件内容（超过 50% 的内容需要修改时）

对于**局部修改**，优先使用 [文件编辑工具 Edit](wiki/core-concepts/tool-system/built-in-tools/edittool)，它更安全、效率更高，且会生成 diff 摘要。


## 使用示例

```
# 创建新配置文件
file_path: "/project/.eslintrc.json"
content: '{
  "extends": ["eslint:recommended"],
  "rules": {
    "no-console": "warn"
  }
}'

# 重写组件文件（先 Read，再 Write）
# 1. 先读取: Read file_path="/project/src/App.tsx"
# 2. 再写入: Write file_path="/project/src/App.tsx" content="..."
```
