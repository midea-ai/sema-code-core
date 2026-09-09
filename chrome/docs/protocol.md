# 扩展协议与接口

桥接进程与扩展之间的约定。原生宿主只转发，不解析。

## 消息格式

JSON 消息，请求 `{v, id, method, params}`，响应 `{v, id, result}` 或 `{v, id, error: {code, message, data?}}`。`v` 是协议版本，当前为 1，只在破坏兼容时递增。没有 `id` 的消息扩展忽略。

## 方法

参数下划线风格，标 * 的必填。

| 方法 | 参数 | 返回 |
|---|---|---|
| ping | 无 | `{protocol, extension_version}` |
| hello | pid | 同 ping；桥接进程每次连上套接字先发，扩展据此复位"立即停止" |
| tabs_list | 无 | `[{tab_id, title, url, agent}]` |
| tabs_open | url | 回执，含 `tab_id` |
| tabs_close | tab_id* | `{tab_id, closed}` |
| navigate | tab_id*，url*（地址或 back、forward、reload） | 回执 |
| read_page | tab_id*，interactive_only 默认 true，max_chars 默认 20000，ref | `{title, url, text, truncated, element_count}` |
| get_text | tab_id* | `{title, url, text}` |
| click | tab_id*，ref*，dialog，dialog_input | 回执 |
| fill | tab_id*，ref*，value*（字符串，复选框与单选框收布尔），dialog，dialog_input | 回执 |
| press | tab_id*，keys*，dialog，dialog_input | 回执 |
| scroll | tab_id*，ref 或 direction*（up、down、left、right） | 回执 |
| screenshot | tab_id*，full_page 默认 false | `{tab_id, title, url, mime, width, height, screens, truncated, data}`，data 是 base64 JPEG |
| console | tab_id*，pattern、only_errors、limit 默认 100、clear | `{tab_id, url, coverage, since, stored, matched, entries: [{ts, level, text}]}` |
| network | tab_id*，url_pattern、limit 默认 100、clear | `{tab_id, url, coverage, since, stored, matched, entries: [{ts, type, method, url, status, status_text, duration_ms, request_body, response_body, error}]}` |
| eval_js | tab_id*，code* | `{tab_id, url, value, truncated, dialog}` |
| upload_begin | tab_id*，ref*，files*（`[{name, type, size}]`） | `{upload_id}` |
| upload_chunk | upload_id*，file*（文件序号），index*（片序号），data*（base64） | `{file, received, size}` |
| upload_commit | upload_id* | 回执，加 `uploaded: [{name, size}]` |

tabs_list 不列隐身窗口和扩展自己的页面。tabs_open 把新标签放进名为 Sema 的标签组，传 url 时等加载完成再返回。tabs_close 只关 Agent 开的标签。tabs_open 与 navigate 的 url 无协议时补 https，本机回环地址（localhost、`*.localhost`、127.x、`[::1]`）补 http；navigate 等 load 事件，30 秒超时返回错误但不回滚。

## 回执

动作类方法（tabs_open、navigate、click、fill、press、scroll）统一返回 `{tab_id, title, url, navigated, dialog}`。

- `navigated`：动作后主框架提交过导航，或 URL 变了。为 true 时元素编号全部作废。
- `dialog`：动作期间页面弹过的原生对话框，没有为 null。结构 `{type, message, response, count}`，type 是 alert、confirm、prompt 之一，`response` 是替页面作的回答（alert 为 null，confirm 为布尔，prompt 为字符串或 null），多个对话框只带最后一个，`count` 是总数。

## 动作

四个动作都在内容脚本里执行，先按 `ref` 找元素，元素不存在或已脱离文档返回 `ref_invalid`。click、fill、press 可带 `dialog`：`dismiss`（缺省）让页面弹的 confirm 得到 false、prompt 得到 null；`accept` 让 confirm 得到 true、prompt 得到 `dialog_input`，没给就用 prompt 自己的默认值。alert 两种策略下都直接返回。

- **click**：元素不可见、disabled、没有尺寸，或中心点被别的元素盖住（`elementFromPoint` 命中不在元素内外任一侧）都返回 `bad_request`。不在视口先 `scrollIntoView` 居中，然后从中心依次派发 pointerdown、mousedown、pointerup、mouseup、click。事件 `isTrusted` 为 false，文件选择框、拖拽和反自动化站点不响应。`option` 元素改为选中它所属的 select。
- **fill**：文本框与 textarea 用原型链的原生 setter 赋值，再派发 input 与 change，受控组件也能收到；赋值后读回不一致（如 number 收到非数字）报 `bad_request`。select 依次按选项文本、值、忽略大小写的文本匹配。checkbox、radio 收布尔（也接受 true/false 字符串），状态不同才触发一次 click；radio 只能设 true。contenteditable 全选后 `execCommand('insertText')`。readonly、disabled、按钮型 input 报 `bad_request`，`type=file` 提示用 file_upload。
- **press**：`keys` 形如 `Enter`、`cmd+shift+Enter`，修饰键接受 ctrl、control、alt、option、shift、meta、cmd、command。作用于焦点元素，穿过 shadow root 与同源 iframe，没有焦点时是 body。派发 keydown 与 keyup（附 `keyCode`、`which` 访问器），keydown 未被 preventDefault 时模拟默认行为：Enter 在表单文本框点默认提交按钮，没有按钮且只有一个文本框才 `requestSubmit`；Enter 在 textarea 插入换行、在按钮和链接上点击；Space 点击按钮与复选框；Tab 按 DOM 顺序移焦点（不处理正 tabindex 与 shadow DOM）；Escape 关闭所在的 `<dialog open>`；cmd/ctrl+a 走选区 API；单字符、Backspace、Delete 在可编辑元素上编辑文本。其他组合只派事件，浏览器级快捷键无效果。
- **scroll**：只传 ref 滚到居中；只传 direction 按窗口一屏滚；两者都传时滚元素最近的可滚动容器一屏，没有容器则滚窗口。

## 导航检测与脚本重注

动作前先挂 `webNavigation.onCommitted`（主框架）监听和 `tabs.onUpdated` 加载监听，内容脚本返回后等 300 毫秒：看到提交就等加载监听的 complete，没看到就撤掉加载监听。两个监听都必须在动作前挂好，本机快页面在动作返回后几毫秒内就 complete，事后再挂会错过。加载监听另有 1 秒兜底，届时标签状态已是 complete 就算完成。30 秒超时返回 `timeout` 并附回执，文字提示可能是 beforeunload 之类的对话框。scroll 不等导航。内容脚本在动作回复前就被卸载时，只要看到过提交也按成功处理。

注入过内容脚本的标签记为受控（`chrome.storage.session` 的 `controlledTabs`），tabs_open 带 url 新建的标签一创建就标为受控。受控标签每次主框架导航提交，后台立即重注内容脚本 `content.js` 与页面世界脚本 `page.js`，条件是新域名已有授权（只查存储，不弹窗）；没授权就跳过，等下一次工具调用走授权流程再注。没赶上的情况下，任何内容脚本调用前都会 ping 一次，没人应答再注入。编号表随旧文档消失，不需要显式清空。

提交时注入对本地快页面来说已经晚了，内联脚本在注入落地前就跑完，加载期的报错和请求会漏。所以 Agent 自己发起、目标 URL 已知的导航（tabs_open 带 url、navigate 到地址或 reload）在导航前用 `chrome.scripting.registerContentScripts` 对该 URL 临时注册 `page.js` 为 `document_start`、`world: MAIN` 的脚本，匹配模式精确到路径与查询串，加载完成或超时即注销，后台启动时清掉残留。back、forward 不知道目标，只靠提交时重注。这段时间用户自己恰好打开同一 URL 也会装上钩子，但没有内容脚本，记录攒 300 条即止，不外发。

`page.js` 同一文档只装一次。它可能先于内容脚本到达，记录先攒着（最多 300 条，满了丢新的，保住 meta 与加载期报错），内容脚本到了互相以 `sema:page-ready`、`sema:hello` 事件握手后补发。对话框武装另用一次 `executeScript` 调 `window.__semaPage.arm`。

## 原生对话框

页面世界脚本以 `chrome.scripting.executeScript({world: 'MAIN'})` 注入，覆盖 `window.alert`、`confirm`、`prompt`：记录类型、文字与替页面作的回答，并以 `sema:dialog` 事件（detail 是 JSON 字符串，对象跨世界读不到）交给内容脚本排队，下一次动作回执带走。回答按武装时带的策略：缺省取消，`accept` 时 confirm 返回 true、prompt 返回指定文字或默认值。

只在"武装"期间接管：内容脚本每个动作开始前通过 `sema:arm` 事件（detail 为 JSON 的 `{ms, accept, input}`）武装 3 秒并设定策略，导航提交后重注时武装 10 秒覆盖加载期间的弹窗，策略为取消，eval_js 执行前也武装 3 秒；其余时间原生弹出，用户自己用同一个标签页不受影响。MV3 没有关闭原生对话框的 API，所以不提供"留着等用户点、超时取消"的模式。武装期外弹出的对话框会卡住页面，下一次内容脚本调用 30 秒超时报错。beforeunload 无法覆盖，同样靠超时。同源 iframe 里脚本弹的对话框不接管。

## 控制台与网络捕获

同一个页面世界脚本里还挂着两组常驻钩子，不受武装窗口限制，页面存活期间一直记录：

- **控制台**：包 `console` 的 log、info、warn、error、debug，先调原方法（DevTools 照常显示）再记录；`window` 的 `error` 事件（捕获阶段，未捕获异常记为 `Uncaught …`，img、script、link 加载失败记为 `Failed to load resource: <url>`）与 `unhandledrejection` 记为 error 级。参数序列化：字符串原样，Error 取 stack，DOM 节点取 `<tag#id.class>`，其他 JSON 化，单条截到 2000 字符。拿不到浏览器自身产生的告警（CSP、CORS、弃用提示）。
- **网络**：包 `window.fetch` 与 `XMLHttpRequest.prototype.open/send`。记请求开始时间、类型（fetch、xhr）、方法、绝对 URL、状态码、耗时、请求体与响应体各前 2000 字符，失败时 status 为 0 并带 `error`。fetch 的响应 `clone()` 后按流读到 2000 字符就 cancel，不整体读入；content-type 不是文本类（text/*、json、xml、javascript、urlencoded）时只记 `[类型, 字节数]`；`no-cors` 的不透明响应记 `[opaque response]`。XHR 在 loadend 读 `responseText`，responseType 非文本只记类型名。看不到文档导航、图片、脚本、样式表、WebSocket、Worker 与跨源 iframe 发出的请求。

记录以 `sema:log` 事件（detail 为 JSON 的 `{kind, entry}`，kind 为 console、network、meta）交给内容脚本，内容脚本按微任务攒一批经 `runtime.sendMessage` 送后台，后台只认主框架（`sender.frameId` 为 0）。钩子首次装上时先发一条 `meta`，带 `document.readyState`：为 `loading` 说明钩子在页面脚本前装上（导航前临时注册的情形），加载期的报错与请求都能捕获；否则加载期的已错过，结果里 `coverage` 为 `partial`，桥接进程会提示模型 reload 后再读。

后台按 tab_id 在内存里存环形缓冲，控制台与网络各 1000 条，满了丢最旧的。只保留当前域名：主框架跨域导航提交、或记录来自别的域名时清空；同源导航保留，并在控制台缓冲里插一条 `nav` 级标记行 `navigated to <url>`。标签关闭即删。缓冲在后台 worker 内存里，worker 与原生端口同生命周期，worker 重启缓冲即空。

console 与 network 读取前都会确保内容脚本在（刚注入时等 100 毫秒让首条记录送达）。`pattern` 与 `url_pattern` 是不区分大小写的正则，非法正则报 `bad_request`；`only_errors` 只留 error 级；`limit` 1 到 1000 取最新；`clear` 读完清空。返回的 `stored` 与 `matched` 不含 nav 标记行。

## 截图

`captureVisibleTab` 只截活动标签：先把标签设为活动（窗口最小化的话先还原，不抢窗口焦点），等 150 毫秒再截。截到的 PNG 在后台用 OffscreenCanvas 缩到 CSS 像素尺寸（Retina 缩回一倍）再编成 JPEG（质量 0.8）返回 base64，再大的压缩交内核。视口截图不依赖内容脚本，内部页只要 Chrome 允许截就能截。

`full_page` 走内容脚本：`metrics` 取整页高度、视口尺寸、当前滚动位置，然后逐屏 `scroll_to`（临时关掉平滑滚动），每屏等 500 毫秒（`captureVisibleTab` 每秒限 2 次）再截，最多 5 屏，滚不动了提前结束，最后滚回原位。按各屏实际滚动位置画到同一张画布上，末屏不足一屏自然重叠。页面高于 5 屏时 `truncated` 为 true。固定定位的头部会在每屏重复；页面在内层容器里滚动而不是窗口滚动时只得到一屏。

## 脚本执行

eval_js 用 `chrome.scripting.executeScript({world: 'MAIN'})` 在页面世界跑一个包装函数。代码先按 `return (<code>)` 当单个表达式用 `AsyncFunction` 编译，所以支持顶层 await；语法不通再按语句体编译，多语句要自己 `return`。返回值在页面里序列化：undefined、null、原始值直接转文字，函数记 `[Function name]`，Error 取 stack，Element 取 outerHTML，Document 取整个 HTML，NodeList 与 HTMLCollection 转数组，其他 JSON 化（Map 转对象、Set 转数组、循环引用退回 `String()`），截到 20000 字符并标 `truncated`。异常在页面里捕获，以 `bad_request` 返回 `Script error: <name>: <message>` 加前三行栈；页面 CSP 禁止 eval 时是 EvalError，错误文字说明这一点。

执行前经内容脚本的 `arm` 武装 3 秒（策略取消），代码调 alert、confirm 不会卡住；执行后带走对话框记录放进 `dialog`，出错时附在错误文字里。30 秒超时返回 `timeout` 并附回执，页面里的 promise 继续悬着无害。

## 文件上传

MCP 工具 `file_upload`（tab_id、ref、paths）只存在于桥接进程，它读本地文件后展开成三个扩展方法，文件内容不经过模型。桥接进程先 stat 每个路径：必须是绝对路径、存在、普通文件，总量不超过 10 MB，超限的错误列出每个文件的大小。然后 `upload_begin` 报文件清单，扩展先经内容脚本确认 `ref` 是 `<input type="file">`、未禁用、多个文件时有 `multiple`，不对就在传任何字节前报 `bad_request`；通过后返回 `upload_id`。接着按文件顺序逐片 `upload_chunk`，每片原始 700 KiB，base64 后约 956 KB，加信封仍在宿主到扩展单条 1 MB 以内，片序号必须连续，收到的字节不能超过声明大小；每片等回执再发下一片。最后 `upload_commit`：扩展把各文件的分片交给内容脚本，解码后 `new File(parts, name, {type})` 放进 `DataTransfer`，赋给 `input.files`，派发 `input` 与 `change`（`bubbles`），页面看到的与用户选完文件一样。commit 走动作的公共路径：武装对话框接管、等 300 毫秒看有没有导航、有就等加载完，回执在标准四项外多一个 `uploaded`，内容是输入框此刻持有的文件名与字节数。

MIME 按扩展名从桥接进程内置的小表取，没有的记 `application/octet-stream`。分片只存在后台内存里，60 秒没有新片或没 commit 即丢弃，commit 时字节数与声明不一致报 `bad_request`。不点原生选择框，也不检查 `accept`，格式不符由页面自己报。

## 立即停止与弹窗

工具栏弹窗 `popup.html` 显示连接状态与未连接原因、正在执行的方法、Agent 打开的标签页数、授权列表（分"总是允许"与"仅本次"，每条可撤销，撤销后下次访问重新弹窗），以及"立即停止"按钮。弹窗与后台之间是 `runtime.sendMessage` 的 `sema:popup` 消息，后台只认扩展自己的页面。

停止是全局的，做在连接层：进行中的每个请求立刻收到 `user_stopped` 错误，对应的 `AbortSignal` 触发，方法本身稍后跑完的结果丢弃。方法在几处看这个信号：等授权时关掉授权窗口、以 `user_stopped` 失败且不缓存为拒绝；调内容脚本前不再派发，等回复期间立刻失败；等页面加载、整页截图逐屏、eval_js 执行都立刻失败；上传分片不再收。已经派给页面的点击或导航收不回来。之后所有请求不执行直接返回 `user_stopped`，只放行 `ping` 与 `hello`。角标显示橙色"停"。复位有两条路：用户在弹窗点"允许继续"，或收到任一桥接进程的 `hello`，也就是有宿主应用重启后连上来。停止标记存 `chrome.storage.session`，后台 worker 重启不丢。

错误文字告诉模型立即结束本轮、汇报进行到哪一步、不要重试，浏览器工具在用户点"允许继续"前一直不可用。

## 元素树

read_page 每行 `[e12] role "名字" 属性…`，按层级两空格缩进。角色由 tag 和 aria 属性映射，`onclick`、`tabindex` 或 `cursor: pointer` 的边界元素记为 `clickable`。隐藏元素按 `checkVisibility` 过滤，同源 iframe 递归进入，跨源 iframe 标 `iframe [cross-origin]`。密码框只显示 `value=(filled)`，不带明文。

编号 `e1`、`e2`… 在一次完整 read_page 里分配。传 `ref` 只读该子树时编号接着往下编，旧编号仍可用；不传 `ref` 的完整读取重新编号，导航后全部作废。用失效编号返回 `ref_invalid`。

interactive_only 为 false 时加入标题、段落、列表项、表格单元格、图片、地标等静态行，以及块级元素的直接文本 `text "…"`。超过 max_chars 按行截断，末尾提示。

## 正文提取

get_text 取正文容器：页面只有一个 `article` 时取它，否则取 `main` 或 `role=main`，再按段落记分选最大文本块，最后退回 body。跳过 nav、脚本、样式和隐藏元素；容器是 body 时再跳过 header、footer、aside。表格单元格用制表符分隔，`pre` 保留空白。

## 错误码

| 错误码 | 含义 |
|---|---|
| not_connected | 桥接进程连不上套接字时自己返回，扩展不产生 |
| site_not_authorized | 站点未授权或隐身标签，`data.host` 是域名 |
| tab_not_found | 标签页不存在 |
| tab_not_owned | 标签页不是 Agent 开的 |
| ref_invalid | 元素编号失效 |
| timeout | 页面加载或内容脚本调用超时，`data` 带当前回执 |
| bad_request | 参数错误、内部页（`chrome://` 等）、无法注入、元素不可点或不可填 |
| unsupported | 扩展版本不支持该方法 |
| user_stopped | 用户在弹窗点了"立即停止"：进行中的请求被中断，或停止后又来了请求 |
| internal | 其他异常 |

## 站点授权

按域名记录，`file://` 归为一个域。首次访问某域名弹窗，三个选择：总是允许存 `chrome.storage.local`，仅本次存 `chrome.storage.session`（浏览器关闭失效），拒绝后 5 分钟内同域名直接返回 `site_not_authorized` 不再弹窗。55 秒不选按拒绝，比桥接进程的 60 秒请求超时短，保证错误能送达。同一域名并发请求共用一个弹窗。两种授权都能在工具栏弹窗里撤销。

## 传输

- **扩展 ↔ 原生宿主**：Chrome 原生消息格式，4 字节小端长度前缀加 UTF-8 JSON。宿主到扩展单条上限 1 MB；扩展到宿主没有这个限制，截图的 base64 走这个方向。套接字上的 JSON 行也不设上限。
- **原生宿主 ↔ 桥接进程**：本机套接字 `~/.sema/chrome/host.sock`，JSON 行协议，一行一条消息。宿主是服务端，桥接进程按需连接、跨调用复用连接。
- **路由**：宿主不解析内容。桥接进程的每一行原样发给扩展；扩展的每条响应广播给所有已连接的桥接进程，各自按 `id` 认领。因此 `id` 由桥接进程保证全局唯一，格式 `<pid>-<启动时间>-<序号>`。
- **生命周期**：宿主随扩展的端口拉起，stdin 关闭即退出，退出不删套接字文件，下一个宿主启动时清理。桥接进程连不上套接字时每个工具调用立刻返回 `not_connected`，不等超时；连接中途断开时进行中的请求同样以 `not_connected` 失败。桥接进程每次连上套接字先发 `hello`，旧扩展回 `unsupported` 也照常工作。桥接进程自己的 stdin 关闭（宿主应用退出）时立即退出：经 `npx` 拉起时中间隔着 npx 与 sh，宿主应用 kill 到的只是 npx，不自己退出会留下孤儿。
- **超时**：桥接进程每个请求 60 秒；扩展侧页面加载 30 秒、内容脚本调用 30 秒、eval_js 执行 30 秒、动作后导航判定 300 毫秒、授权窗口 55 秒。

## 原生宿主清单

原生宿主名 `com.sema.chrome`，扩展 ID `pjofgjgagohldpbcnkgnfjeehealejie`（商店分配，仓库 manifest 的 key 即商店公钥，解压加载 ID 相同；可用环境变量 `SEMA_CHROME_EXTENSION_IDS` 追加，逗号分隔）。桥接进程启动时幂等写入 macOS 的 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` 或 Linux 的 `~/.config/google-chrome/NativeMessagingHosts/`，其他平台记一条 stderr 日志后继续运行：

```json
{
  "name": "com.sema.chrome",
  "description": "Sema browser control native host",
  "path": "/absolute/path/to/host-wrapper.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://pjofgjgagohldpbcnkgnfjeehealejie/"]
}
```

Chrome 拉起宿主时不带 PATH，`path` 指向 `~/.sema/chrome/native-host.sh`，脚本里写死当前 node 与 `native-host.js` 的绝对路径，内容变了才重写。`native-host.js` 的位置按桥接进程自己所在的包解析：仓库内运行是 `chrome/host/native-host.js`，`npx -y sema-chrome-host` 运行是 npx 缓存目录 `~/.npm/_npx/<hash>/node_modules/sema-chrome-host/native-host.js`，全局安装是全局 `node_modules` 下的对应文件。缓存被清或包升级换了目录后，Chrome 拉不起宿主，扩展持续重连，直到下一次桥接进程启动重写包装脚本。扩展端口断开后 2 秒重连，连续失败逐步退到 30 秒。

## 版本

`hello` 与 `ping` 返回 `{protocol, extension_version}`，只供排障查看，桥接进程不据此做校验或提示。扩展与桥接进程版本不一致时照常工作：桥接进程有而扩展没有的方法由扩展返回 `unsupported`，错误文字里带扩展版本并提示升级扩展；扩展有而桥接进程没有的方法不会被调用。协议版本 `v` 只在破坏兼容时递增，加方法、加参数、加返回字段都不算；扩展侧不校验请求里的 `v`。

## MCP 工具结果

桥接进程把扩展结果转成文本：tabs_list 一行一个标签 `<tab_id> [agent] "<title>" <url>`；回执类工具（tabs_open、navigate、click、fill、press、scroll）返回 `tab_id / title / url / navigated` 四行，有对话框时加一行 `dialog: confirm "文字" (auto-dismissed, returned false)` 或 `(auto-accepted, returned true)`，多个时注明总数；read_page 与 get_text 前两行是 `Title:` 与 `URL:`，空一行后是正文。错误统一为 `[<code>] <message>` 并置 `isError`，超时错误附 `Current page:` 与当前回执。

file_upload 在回执四行后加 `uploaded:` 与每个文件一行 `名字 (字节数 bytes)`。

排障工具：screenshot 返回 content 数组，先一个 image 块（`image/jpeg`），再一行文字写 tab_id、标题、URL、尺寸、拼了几屏、是否截断；console 头部是 tab_id、URL、覆盖范围提示（`coverage` 为 partial 时提示 reload）、`N of M matching messages shown (S stored)`，然后每行 `HH:MM:SS.mmm [level] 文字`，nav 标记行写成 `--- 时间 navigated to … ---`；network 每条请求一块，首行 `时间 METHOD URL -> 状态 (耗时 ms, fetch|xhr)`，下面缩进 `request:` 与 `response:`；eval_js 返回值原文，截断时末尾注明，有对话框时空一行后加 `dialog:` 一行，格式同回执。
