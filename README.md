<div align="center">

<img src="./imgs/logo.png" alt="Sema Code Core Logo" width="75%"/>

事件驱动型 AI 编程助手核心引擎，为构建代码助手工具提供可靠、可插拔的智能处理能力
</br>
<em>An Event-Driven AI Coding Assistant Core Engine</em>

[![GitHub License](https://img.shields.io/github/license/midea-ai/sema-code-core?style=flat-square)](https://github.com/midea-ai/sema-code-core/blob/main/LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/midea-ai/sema-code-core)
[![npm version](https://img.shields.io/npm/v/sema-core?style=flat-square)](https://www.npmjs.com/package/sema-core)


</div>

## 项目概述

**Sema Code Core** 是一个事件驱动型 AI 编程助手核心引擎，为构建代码助手工具提供可靠、可插拔的智能处理能力。支持多智能体协同、Skill 扩展、Plan 模式任务规划等核心能力，可快速集成到各类 AI 编程工具中。

## 核心特性
- **自然语言指令** - 通过自然语言直接驱动编程任务
- **权限控制** - 细粒度的权限管理，确保操作安全可控
- **Subagent 管理** - 支持多智能体协同工作，可根据任务类型动态调度合适的子代理
- **Skill 扩展机制** - 提供插件化架构，可灵活扩展 AI 编程能力
- **Plan 模式任务规划** - 支持复杂任务的分解与执行规划
- **MCP 协议支持** - 内置 Model Context Protocol 服务，支持工具扩展
- **多模型支持** - 兼容 Anthropic、OpenAI SDK，支持国内外主流厂商 LLM API

## 适用场景

**IDE/编辑器插件开发**：为编辑器提供底层AI能力封装，开发者只需专注UI交互，无需自研复杂的大模型调度与工具调用逻辑。

**企业内部研发工具**：私有化部署+权限管控，适配企业自有模型与安全规范。开箱即用的工具链，避免从零构建AI编程基础设施。

**垂直领域智能工作流**：将复杂工程任务（迁移、重构、文档）拆解为自动化流程。多智能体协同执行，替代人工处理重复性代码工作。

**学术研究与 Agent 原型验证**：为学术机构与独立研究者提供轻量级 Agent 实验环境，支持灵活组合工具链与智能体策略，让研究者聚焦算法创新。

## 使用案例

### VSCode Extension

[Sema Code VSCode Extension](https://github.com/midea-ai/sema-code-vscode-extension) 是基于 Sema Code Core 引擎的VSCode智能编程插件。

<img src="./imgs/sema.gif" alt="Sema Code VSCode Extension" />  

### Code to Skill: 代码库生成skill

<img src="./imgs/code-to-skill.jpg" alt="Code to Skill" />

## 快速开始

### 安装

```bash
npm install sema-core
```

### 开始使用

创建实例：

```typescript
import { SemaCore } from 'sema-core';

const sema = new SemaCore({
  workingDir: '/path/to/your/project'
});
```

会话管理：

```typescript
await sema.createSession();
await sema.processUserInput('帮我分析这个项目的结构');
```

事件监听：

```typescript
// 监听 AI 流式响应
core.on('message:text:chunk', (data) => {
  process.stdout.write(data.delta || '');
});

// 监听工具执行结果
sema.on('tool:execution:complete', (data) => {
  console.log('工具执行结果:', data);
});

// 监听工具权限请求
sema.on('tool:permission:request', (data) => {
  console.log('工具权限请求:', data);
  const selected = 'agree';
  sema.respondToToolPermission({ toolName: data.toolName, selected });
});
```

## 开发

```bash
# 1. 安装依赖
npm install

# 2. 编译
npm run build

# 3. 运行
node test/addModel.test.js
node test/miniCli.test.js
```

<img src="./imgs/mini-cli.png" alt="miniCli" />

ripgrep 跨平台打包说明（Mac/Win 兼容）：

```bash
# 首次打包前，下载双平台 ripgrep 依赖文件
./download-ripgrep.sh
```

