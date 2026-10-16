# sema-code-ui

SemaWork 的命令行启动器（命令名 `sema-ui`）：一条命令在浏览器里打开基于 sema-core 的本地 Web 界面。服务端、页面与桌面版（`desktop/`）同源，产物自包含，运行时依赖来自本包 `node_modules`。

## 安装与使用

要求 Node ≥ 20.18.1。

```bash
npm i -g sema-code-ui
sema-ui                       # 启动服务并打开浏览器；已在运行则只打开页面（等同 sema-ui start）
sema-ui status                # 端口 / 地址 / 版本 / pid
sema-ui open                  # 只打开页面，不重复起服务
sema-ui stop                  # 结束运行中的实例
```

启动参数：`--port 3210` 改端口；`--token xxx` 指定 token；`--no-open` 不打开浏览器，可直接跟在 `sema-ui` 后。Ctrl+C 或关闭终端即停止服务，正在运行的任务会被中断。终端只打启动地址与关闭提示；服务内部错误写 `~/.sema/webui/error.log`（每次启动清空），core 运行日志在 `~/.sema/logs/`。

数据目录 `~/.sema/webui/`（项目 / 会话索引、设置、token、运行记录 `run.json`），与 `npm start`、桌面版共用，详见 `webui/README.md`「数据位置」。实例检测、关闭链与打包布局的设计见 [docs/design.md](docs/design.md)。

## 构建与发布

```bash
cd webui && npm run build                               # 先出 client/dist（已构建根目录 sema-core）
cd cli && npm install && npm run build && npm pack      # 产物 dist/：cli.js、worker-entry.js、public/、resources/
npx -y -p ./sema-code-ui-<版本>.tgz sema-ui              # 本地验证（-y 跳过安装确认）
npm publish
```

