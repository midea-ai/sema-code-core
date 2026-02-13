# 文件编辑工具 Edit

对文件进行精确的字符串替换，输出 diff 格式的变更摘要。比 Write 更安全，适合局部修改。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file_path` | `string` | ✓ | 目标文件绝对路径 |
| `old_string` | `string` | ✓ | 要替换的原始文本（必须在文件中唯一存在） |
| `new_string` | `string` | ✓ | 替换后的新文本（必须与 `old_string` 不同） |
| `replace_all` | `boolean` | — | 替换所有匹配项，默认 `false` |

## 基本属性

- **isReadOnly**：`false`（串行执行）
- **权限**：受 `skipFileEditPermission` 控制（默认跳过）


## 核心规则

### 必须先 Read

**使用 Edit 前必须先用 Read 读取目标文件**。Edit 会验证文件的读取时间戳，若文件未被读取（或读取后被外部修改），工具会拒绝执行。

### old_string 必须唯一

`old_string` 在文件中必须唯一出现（除非 `replace_all: true`）。若有多处匹配，Edit 会报错并要求提供更多上下文以确保唯一性。

### 保持缩进和换行

替换时需完整保留原始文本的缩进、空格和换行格式，否则可能匹配失败。


## 输出

Edit 成功后返回 diff 格式的变更摘要，展示修改了哪些行：

```diff
- const foo = 'old value'
+ const foo = 'new value'
```


## 使用示例

```
# 修改函数实现
file_path: "/project/src/utils.ts"
old_string: "function add(a: number, b: number) {
  return a + b
}"
new_string: "function add(a: number, b: number): number {
  return a + b
}"

# 替换导入语句
file_path: "/project/src/index.ts"
old_string: "import { foo } from './old-module'"
new_string: "import { foo } from './new-module'"

# 批量替换变量名
file_path: "/project/src/config.ts"
old_string: "oldName"
new_string: "newName"
replace_all: true
```


## Write vs Edit

| 场景 | 推荐工具 |
|------|---------|
| 创建新文件 | Write |
| 修改文件中少量内容 | **Edit**（更安全，有 diff） |
| 重写文件 50% 以上内容 | Write |
| 批量替换变量名 | Edit（`replace_all: true`） |
