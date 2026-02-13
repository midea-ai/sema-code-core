# Sema Core 文档

<div align="center" style="margin: 36px 0 24px;">
  <img src="images/semacode-logo.png" alt="SemaCode" style="max-width: 360px; width: 60%;">
  <p style="margin-top: 16px; font-size: 18px; color: #555;">事件驱动的 AI Agent 核心引擎</p>
</div>

**Sema Code Core** 是一个面向开发者的 TypeScript 库，提供构建 AI 编程助手所需的全部核心能力：工具执行、事件驱动、MCP 集成、Skill 系统、SubAgent 编排。


## 文档导航

### 入门

- [项目概述](wiki/overview/project) — 架构、技术栈、目录结构
- [架构概述](wiki/overview/architecture) — 分层设计与数据流
- [快速开始](wiki/getting-started/quick-start) — 5 分钟上手示例

### 基础用法

- [新增模型](wiki/getting-started/basic-usage/add-new-model) — 支持多种 LLM 提供商
- [基础用法](wiki/getting-started/basic-usage/basic-usage) — 配置与会话管理
- [MCP 使用](wiki/getting-started/basic-usage/mcp-usage) — 扩展 AI 工具能力
- [Skill 使用](wiki/getting-started/basic-usage/skill-usage) — 创建可复用工作流
- [SubAgent 使用](wiki/getting-started/basic-usage/subagent-usage) — 专用子代理

### 扩展应用
- [VSCode 插件](wiki/scenarios/vscode-extension) — IDE 集成
- [Code2Skill](wiki/scenarios/code2skill) — 从代码库生成 Skill

### 核心概念
- [SemaCore](wiki/core-concepts/core-architecture/sema-core-public-api) - Sema Code Core 公开API入口类
- [工具架构](wiki/core-concepts/tool-system/tool-architecture) — 工具接口与注册
- [事件类型](wiki/core-concepts/event-system/event-catalog) — 完整事件参考
- [权限系统](wiki/core-concepts/tool-system/permission-system) — 权限检查流程

### 生态扩展

- [MCP 集成](wiki/core-concepts/advanced-topics/mcp-integration) — 协议与连接管理
- [Skill 支持](wiki/core-concepts/advanced-topics/skill-support) — Skill 系统详解
- [Plan 模式](wiki/core-concepts/advanced-topics/plan-mode) — 规划与执行分离
- [SubAgent 子代理](wiki/core-concepts/advanced-topics/subagents) — 内置子代理实现


