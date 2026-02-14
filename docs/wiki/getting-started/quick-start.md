# 快速开始

### 1. 新建项目并安装依赖

```bash
mkdir my-app && cd my-app
npm init -y
npm install sema-core
```

### 2. 下载示例文件

将 [quickstart.mjs](https://github.com/midea-ai/sema-code-core/tree/main/example/quickstart.mjs) 下载到 `my-app` 目录，然后修改以下两处配置：

```js
const core = new SemaCore({
  workingDir: '/path/to/your/project', // Agent 将操作的目标代码仓库路径
  ...
});

const modelConfig = {
  apiKey: 'sk-your-api-key', // 替换为你的 API Key
  ...
};
```

更多模型配置参考[模型管理](wiki/getting-started/basic-usage/add-new-model)

### 3. 运行

```bash
node quickstart.mjs
```

<img src="images/mini-cli.png" alt="miniCli" />

## 关键概念

| 概念 | 说明 | 文档 |
|------|------|------|
| **SemaCore** | 公共 API 入口，所有操作都通过它进行 | [SemaCore - 公共API层](wiki/core-concepts/core-architecture/sema-core-public-api) |
| **SemaEngine** | 核心引擎，负责协调所有子系统的初始化和运行时调度 | [SemaEngine - 业务逻辑](wiki/core-concepts/core-architecture/sema-engine-business-logic)  |
| **事件系统** | 流式输出、状态变化、工具执行均通过事件通知 | [事件总线架构](wiki/core-concepts/event-system/event-bus) |
| **工具权限** | 写操作（Bash、Edit 等）默认需要用户授权 | [权限系统](wiki/core-concepts/tool-system/permission-system) |
| **MCP** | 通过标准协议为 AI 扩展自定义工具 | [MCP 集成](wiki/core-concepts/advanced-topics/mcp-integration) |
| **Skill** | 可复用的 AI 工作流，存储为 Markdown 文件 | [Skill 支持](wiki/core-concepts/advanced-topics/skill-support) |
| **SubAgent** | 隔离执行的专用子代理 | [SubAgent 子代理](wiki/core-concepts/advanced-topics/subagents) |
