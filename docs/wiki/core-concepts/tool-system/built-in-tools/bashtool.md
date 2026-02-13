# 终端工具 Bash

在持久化 Shell 进程中执行命令，工作目录状态跨调用保持。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | `string` | ✓ | 要执行的 Shell 命令 |
| `description` | `string` | ✓ | 命令描述（5-10 字，主动语态）|
| `timeout` | `number` | — | 超时毫秒数，最大 180000ms（3分钟），默认 60000ms（1分钟）|

## 基本属性

- **isReadOnly**：`false`（串行执行）
- **权限**：默认需要确认（`skipBashExecPermission` 控制）


## 安全限制

### 禁止命令

以下命令被完全禁止，调用会直接返回错误（不走权限流程）：

```
alias, curl, curlie, wget, axel, aria2c,
nc, telnet, lynx, w3m, links,
httpie, xh, http-prompt,
chrome, firefox, safari
```

### cd 目录限制

`cd` 命令只能进入**工作目录的子目录**，不能跨出项目根目录：

```bash
cd src/utils    # ✓ 允许
cd ..           # ✗ 跨出工作目录，被阻止
cd /tmp         # ✗ 绝对路径跨出，被阻止
```


## 权限粒度

Bash 权限按**命令前缀**存储，授权 `npm run` 后，所有以 `npm run` 开头的命令自动通过：

```
授权: Bash(npm run)
允许: npm run test、npm run build、npm run lint
不允许: npm install（前缀不同）
```


## 持久化 Shell

所有 Bash 调用共享同一个持久化 Shell 进程，`cd` 和环境变量变更在调用间保持：

```bash
# 第一次调用
cd src/

# 第二次调用（在 src/ 目录中执行）
ls -la
```


## 输出格式

工具返回：

```javascript
{
  stdout: string       // 标准输出
  stdoutLines: number  // 输出行数
  stderr: string       // 标准错误
  stderrLines: number  // 错误行数
  interrupted: boolean // 是否被中断
  command?: string     // 执行的命令
}
```

输出超过 30000 字符时自动截断：保留头尾各 15000 字符，中间省略部分显示被截断的行数。在工具结果面板中，最多渲染最后 10 行内容。


## 使用示例

```bash
# 查看 git 状态
git status

# 运行测试（需要权限，首次确认）
npm run test

# 链式命令
git add . && git commit -m "feat: add new feature"

# 管道命令
cat package.json | jq '.dependencies'
```
