<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/images/semacode-logo-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="./docs/images/semacode-logo.png">
  <img src="./docs/images/semacode-logo.png" alt="Sema Code Core Logo" width="75%"/>
</picture>

<h3>An Event-Driven AI Coding Assistant Core Engine</h3>

<p>Providing reliable and pluggable intelligent processing capabilities for building code assistant tools.</p>

[![GitHub License](https://img.shields.io/github/license/midea-ai/sema-code-core?style=flat-square)](https://github.com/midea-ai/sema-code-core/blob/main/LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/midea-ai/sema-code-core)
[![npm version](https://img.shields.io/npm/v/sema-core?style=flat-square)](https://www.npmjs.com/package/sema-core)
[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-blue?style=flat-square)](https://midea-ai.github.io/sema-code-core)
[![DOI](https://img.shields.io/badge/DOI-10.1145%2F3837729.3840503-0085CA?style=flat-square)](https://doi.org/10.1145/3837729.3840503)
[![arXiv](https://img.shields.io/badge/arXiv-2604.11045-b31b1b?style=flat-square)](https://arxiv.org/abs/2604.11045)

[中文](./README_CN.md) | **English**

</div>

## 📖 Project Overview

**Sema Core** is an event-driven AI coding assistant core engine that provides reliable and pluggable intelligent processing capabilities for building code assistant tools. It supports core capabilities such as multi-agent collaboration, Skill extension, and Plan mode task planning, and can be quickly integrated into various AI programming tools.

[View Documentation](https://midea-ai.github.io/sema-code-core)

## 💼 Use Cases

### SemaCode Extension (VSCode / JetBrains)

[SemaCode Extension](https://github.com/midea-ai/sema-code-vscode-extension) is an intelligent programming plugin based on the Sema Core engine, supporting both the VSCode extension and JetBrains plugins (IntelliJ IDEA / PyCharm / GoLand / WebStorm / CLion, etc.).

<p align="center">
  <img src="https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/plan-mode.gif" alt="Sema Code VSCode Extension"/>
</p>

### SemaWork

[SemaWork](./webui/README.md) is a local web UI built on Sema Core.

<p align="center">
  <img src="https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/webui.gif" alt="SemaWork"/>
</p>

### SemaPLC

[SemaPLC](https://github.com/midea-ai/SemaPLC) is an IDE for industrial PLC programming — describe a control task in natural language and watch it become a running PLC program, powered by the embedded Sema Core Agent.

<p align="center">
  <img src="https://github.com/midea-ai/SemaPLC/raw/main/docs/images/demo.gif" alt="SemaPLC"/>
</p>

### SemaClaw 

[SemaClaw](https://github.com/midea-ai/SemaClaw) is a general-purpose engineering harness for building personal AI agents.

<p align="center">
  <img src="https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/semaclaw-intro.GIF" alt="SemaClaw"/>
</p>

## 🚀 Quick Start

Get [SemaWork](./webui/README.md) running locally with one command (Node ≥ 20.18.1):

```bash
npm i -g sema-code-ui
sema-ui        # starts the server and opens the browser
```

Or run it from source in two steps:

### 1. Clone and build

```bash
git clone https://github.com/midea-ai/sema-code-core.git
cd sema-code-core && npm install && npm run build
```

### 2. Start SemaWork

```bash
cd webui && npm install && npm run build
npm start
```

Then open the URL printed in the terminal (`http://127.0.0.1:3210/?token=…`) in your browser, or run `npm start -- --open` to open it automatically.

## 🛠 Development

```bash
# 1. Install dependencies
npm install

# 2. Build
npm run build

# 3. Pack (optional): creates sema-core-x.y.z.tgz for local testing via npm install <tgz>
npm pack
```

Non-Node projects can integrate via the [multi-language SDKs](./sdks/README.md) (Java / Python / C#).

## 📝 Citation

If you use Sema Core in your research, please cite our [SPLASH '26 paper](https://doi.org/10.1145/3837729.3840503):

```bibtex
@inproceedings{wang2026semacore,
  title     = {Sema Core: An Open, Embeddable AI Coding Agent Runtime for the IDE and Beyond},
  author    = {Wang, Huacan and Zhou, Jie and Zhu, Ningyan and Zhang, Shuo and Tu, Yanlun and Chen, Feiyu and Wu, Jiarou and Zhou, Ziyue and Chen, Ge and Liu, Chen and Chen, Wangyi and Mou, Xiaofeng and Xu, Yi},
  booktitle = {Companion Proceedings of the 2026 ACM SIGPLAN International Conference on Systems, Programming, Languages, and Applications: Software for Humanity},
  series    = {SPLASH '26},
  publisher = {ACM},
  year      = {2026},
  pages     = {220--225},
  doi       = {10.1145/3837729.3840503},
  eprint    = {2604.11045},
  archivePrefix = {arXiv}
}
```

## 📜 License

`sema-core` is released under the [MIT License](./LICENSE). See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for the third-party dependency list and external service terms.
