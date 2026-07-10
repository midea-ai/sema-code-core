# IDE 插件（VSCode / JetBrains）

## 项目概述

**Sema Code Extension** 是基于 Sema Core 引擎的智能编程插件。它将 Sema Core 的所有核心能力——LLM 编排、多 Agent 协作、工具执行、权限控制、Skill/MCP 扩展——以图形化交互界面呈现给 IDE 用户，同时支持 **VSCode 插件** 和 **JetBrains 插件**（IntelliJ IDEA / PyCharm / GoLand / WebStorm / CLion 等）。

完整的插件项目：[sema-code-vscode-extension](https://github.com/midea-ai/sema-code-vscode-extension)（含 [JetBrains 插件](https://github.com/midea-ai/sema-code-vscode-extension/tree/main/jetbrains-plugin)）

<img src="https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/plan-mode.gif" alt="Sema Code VSCode Extension"/>


## 核心特性
- **自然语言指令** - 通过自然语言直接驱动编程任务
- **权限控制** - 细粒度的权限管理，确保操作安全可控
- **Subagent 管理** - 支持多智能体协同工作，可根据任务类型动态调度合适的子代理
- **Skill 扩展机制** - 提供插件化架构，可灵活扩展 AI 编程能力
- **Plan 模式任务规划** - 支持复杂任务的分解与执行规划
- **MCP 协议支持** - 内置 Model Context Protocol 服务，支持工具扩展
- **多模型支持** - 兼容 Anthropic、OpenAI SDK，支持国内外主流厂商 LLM API


## 安装与使用

### VSCode

1. 打开 Visual Studio Code  
2. 进入扩展视图 (`Ctrl+Shift+X`)  
3. 搜索 `Sema Code` 并点击安装  
4. 或从 [GitHub Releases](https://github.com/midea-ai/sema-code-vscode-extension/releases) 下载 VSIX 手动安装

### JetBrains（IntelliJ IDEA / PyCharm / GoLand / WebStorm / CLion 等）

1. 打开 JetBrains IDE  
2. 进入 `Settings` → `Plugins` → `Marketplace`  
3. 搜索 `Sema Code` 并点击安装  
4. 或从 [GitHub Releases](https://github.com/midea-ai/sema-code-vscode-extension/releases) 下载插件包，通过 `Install Plugin from Disk...` 手动安装