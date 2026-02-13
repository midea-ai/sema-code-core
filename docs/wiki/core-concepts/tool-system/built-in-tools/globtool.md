# 文件搜索工具 Glob

按 glob 模式搜索文件，返回匹配的文件路径列表（按修改时间降序排列）。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pattern` | `string` | ✓ | Glob 匹配模式 |
| `path` | `string` | — | 搜索根目录，默认为当前工作目录。**注意**：若使用默认目录，直接省略此参数，不要传入 `"undefined"` 或 `"null"`；若提供则必须是有效的目录路径 |

## 基本属性

- **isReadOnly**：`true`（可并发执行）
- **权限**：无需权限


## Glob 语法

| 语法 | 含义 | 示例 |
|------|------|------|
| `*` | 匹配单层任意字符（不含 `/`） | `*.ts` |
| `**` | 匹配任意层目录 | `**/*.ts` |
| `?` | 匹配单个字符 | `file?.ts` |
| `{a,b}` | 匹配多个选项 | `*.{ts,tsx}` |
| `[abc]` | 匹配字符集 | `[abc].ts` |


## 使用示例

```
# 搜索所有 TypeScript 文件
pattern: "**/*.ts"

# 搜索 src 目录下的组件文件
pattern: "src/**/*.{tsx,jsx}"
path: "/path/to/project"

# 搜索特定目录的配置文件
pattern: "*.config.{js,ts,json}"

# 搜索测试文件
pattern: "**/*.{test,spec}.{ts,js}"

# 搜索所有 Markdown 文档
pattern: "docs/**/*.md"
```


## 返回值

匹配的文件路径字符串，按文件修改时间从新到旧排列，每行一个路径：

```
/project/src/core/SemaCore.ts
/project/src/core/SemaEngine.ts
/project/src/tools/Bash/Bash.ts
...
```

最多返回 **100** 个文件，超出时附加提示：

```
(Results are truncated. Consider using a more specific path or pattern.)
```


## 使用建议

- 优先使用 Glob 而非 `Bash find`，Glob 是只读工具可并发执行
- 搜索结果较多时结合 `Grep` 进一步过滤
- 不确定文件位置时，先用 Glob 定位再用 Read 读取
- 进行开放式搜索（可能需要多轮 glob/grep 组合）时，建议改用 Agent 工具
