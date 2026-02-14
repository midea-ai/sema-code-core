<div align="center">

<img src="./docs/images/semacode-logo.png" alt="Sema Code Core Logo" width="75%"/>

<h3>An Event-Driven AI Coding Assistant Core Engine</h3>

<p>Providing reliable and pluggable intelligent processing capabilities for building code assistant tools.</p>

[![GitHub License](https://img.shields.io/github/license/midea-ai/sema-code-core?style=flat-square)](https://github.com/midea-ai/sema-code-core/blob/main/LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/midea-ai/sema-code-core)
[![npm version](https://img.shields.io/npm/v/sema-core?style=flat-square)](https://www.npmjs.com/package/sema-core)
[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-blue?style=flat-square)](https://midea-ai.github.io/sema-code-core)

<br/>

[简体中文](./README_CN.md) | **English**

</div>

---

## Table of Contents

- [Core Features](#-core-features)
- [Use Cases](#-use-cases)
- [Quick Start](#-quick-start)
- [Development](#-development)

---

## Project Overview

**Sema Code Core** is an event-driven AI coding assistant core engine that provides reliable and pluggable intelligent processing capabilities for building code assistant tools. It supports core capabilities such as multi-agent collaboration, Skill extension, and Plan mode task planning, and can be quickly integrated into various AI programming tools.

> **[View Full Documentation](https://midea-ai.github.io/sema-code-core)**

## ✨ Core Features

| Feature | Description |
|:--------|:------------|
| **Natural Language Instructions** | Directly drive programming tasks through natural language |
| **Permission Control** | Fine-grained permission management ensures safe and controllable operations |
| **Subagent Management** | Multi-agent collaboration with dynamic sub-agent scheduling based on task types |
| **Skill Extension Mechanism** | Plugin architecture to flexibly extend AI programming capabilities |
| **Plan Mode Task Planning** | Decomposition and execution planning of complex tasks |
| **MCP Protocol Support** | Built-in Model Context Protocol service to support tool extension |
| **Multi-Model Support** | Compatible with Anthropic, OpenAI SDK, and LLM APIs from major vendors |

## 🎯 Scenarios

- **IDE / Editor Plugin Development** — Provides low-level AI capability encapsulation for editors, allowing developers to focus on UI interaction without self-developing complex large model scheduling and tool calling logic.

- **Enterprise Internal R&D Tools** — Private deployment + permission control, adapting to enterprise-owned models and security specifications. Out-of-the-box toolchain avoids building AI programming infrastructure from scratch.

- **Vertical Domain Intelligent Workflow** — Decomposes complex engineering tasks (migration, refactoring, documentation) into automated processes. Multi-agent collaborative execution replaces manual processing of repetitive coding work.

- **Academic Research & Agent Prototype Verification** — Provides a lightweight Agent experimental environment for academic institutions and independent researchers, supporting flexible combinations of toolchains and agent strategies, allowing researchers to focus on algorithmic innovation.

## 📦 Use Cases

### VSCode Extension

[Sema Code VSCode Extension](https://github.com/midea-ai/sema-code-vscode-extension) is a VSCode intelligent programming plugin based on the Sema Code Core engine.

<p align="center">
  <img src="./docs/images/sema.gif" alt="Sema Code VSCode Extension" width="90%"/>
</p>

### Skill Web App

A Skill web application based on Sema Code Core, integrating Agent Skill Browser / Creator / Playground demo.

<p align="center">
  <img src="./docs/images/skill-web-app-demo.gif" alt="Skill Web App" width="90%"/>
</p>

## 🚀 Quick Start

### Installation

```bash
mkdir my-app && cd my-app
npm init -y
npm install sema-core
```

### Interactive CLI Example

Here is a complete command-line dialogue example [quickstart.mjs](https://github.com/midea-ai/sema-code-core/tree/main/example/quickstart.mjs), save it locally and run:

```bash
node quickstart.mjs
```

### Minimal Example

将 [quickstart.mjs](https://github.com/midea-ai/sema-code-core/tree/main/example/quickstart.mjs) 下载到 `my-app` 目录，然后修改以下两处配置：

// 1. Create an instance
const sema = new SemaCore({
  '/path/to/your/project', // Change to your project path
})

// 2. Add Model
// Configure model (Taking DeepSeek as an example, see "Add Model" documentation for more providers)
const modelConfig = {
  provider: 'deepseek',
  modelName: 'deepseek-chat',
  baseURL: 'https://api.deepseek.com/anthropic',
  apiKey: 'sk-your-api-key', // Replace with your API Key
  maxTokens: 8192,
  contextLength: 128000
};
const modelId = `${modelConfig.modelName}[${modelConfig.provider}]`;
await core.addModel(modelConfig);
await core.applyTaskModel({ main: modelId, quick: modelId });

// 3. Listen for streaming text output
sema.on('message:text:chunk', ({ delta }) => {
  process.stdout.write(delta ?? '')
})

// 4. Listen for tool execution
sema.on('tool:execution:complete', ({ toolName, summary }) => {
  console.log(`\n[${toolName}] ${summary}`)
})

// 5. Handle permission requests
sema.on('tool:permission:request', ({ toolName }) => {
  // Automatically agree (please implement interactive confirmation for production environment)
  sema.respondToToolPermission({ toolName, selected: 'agree' })
})

// 6. Listen for completion signal
sema.on('state:update', ({ state }) => {
  if (state === 'idle') console.log('\n--- Completed ---\n')
})

// 7. Create session and send message
await sema.createSession()
sema.processUserInput('Help me analyze the code structure of this project')
```

## 🛠 Development

```bash
# 1. Install dependencies
npm install

# 2. Build
npm run build

# 3. Run tests
node test/addModel.test.js
node test/miniCli.test.js
```

<p align="center">
  <img src="./imgs/mini-cli.png" alt="miniCli" width="80%"/>
</p>

<details>
<summary><strong>ripgrep Cross-Platform Packaging (Mac/Win)</strong></summary>

```bash
# Before the first package, download the dual-platform ripgrep dependency files
./download-ripgrep.sh
```

</details>
