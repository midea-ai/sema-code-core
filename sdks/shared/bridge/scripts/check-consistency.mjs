// 契约一致性校验（三期防漂移，npm run check:contract）：
//   ① server.ts 路由表 case 标签  ==  manifest/actions.json 的 action 清单
//   ② Java SDK 镜像方法的 action 字符串  ==  manifest（SemaCore/SemaSession 的 call/jsonCall/voidCall/pluginCall 调用点）
//   ③ Java SemaEvents 常量值  ==  manifest 事件清单（session + process + synthetic）
//   ④ Python SDK 镜像方法的 action 字符串  ==  manifest（api.py 的 call/_json/_call/_plugin 调用点）
//   ⑤ Python events.py 常量值  ==  manifest 事件清单
//   ⑥ C# SDK 镜像方法的 action 字符串  ==  manifest（SemaCore/SemaSession 的 Call/JsonCall/VoidCall/PluginCall 调用点）
//   ⑦ C# SemaEvents 常量值  ==  manifest 事件清单
//   ⑧ 协议版本五处一致：manifest == server.ts == Java SemaConstants == Python constants.py == C# SemaConstants
// 任何一边增删 action/事件而没同步其它几边，此脚本即失败——请一并更新后重跑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bridgeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// bridge 现位于 sdks/shared/bridge，回退两级到 sdks/（java|python|csharp 所在层）
const sdksDir = path.resolve(bridgeDir, '..', '..');
const read = (p) => fs.readFileSync(p, 'utf8');

const manifest = JSON.parse(read(path.join(bridgeDir, 'manifest', 'actions.json')));
const serverTs = read(path.join(bridgeDir, 'src', 'server.ts'));
const javaApiDir = path.join(sdksDir, 'java', 'src', 'main', 'java', 'com', 'sema', 'sdk', 'api');
const semaCoreJava = read(path.join(javaApiDir, 'SemaCore.java'));
const semaSessionJava = read(path.join(javaApiDir, 'SemaSession.java'));
const semaEventsJava = read(path.join(javaApiDir, 'SemaEvents.java'));
const semaConstantsJava = read(path.join(javaApiDir, 'SemaConstants.java'));
const pyDir = path.join(sdksDir, 'python', 'src', 'sema_core');
const apiPy = read(path.join(pyDir, 'api.py'));
const eventsPy = read(path.join(pyDir, 'events.py'));
const constantsPy = read(path.join(pyDir, 'constants.py'));
const csApiDir = path.join(sdksDir, 'csharp', 'Api');
const semaCoreCs = read(path.join(csApiDir, 'SemaCore.cs'));
const semaSessionCs = read(path.join(csApiDir, 'SemaSession.cs'));
const semaEventsCs = read(path.join(csApiDir, 'SemaEvents.cs'));
const semaConstantsCs = read(path.join(csApiDir, 'SemaConstants.cs'));

let failed = false;
const fail = (msg) => { failed = true; console.error(`✗ ${msg}`); };
const ok = (msg) => console.log(`✓ ${msg}`);
const diff = (label, a, b, aName, bName) => {
  const onlyA = [...a].filter((x) => !b.has(x)).sort();
  const onlyB = [...b].filter((x) => !a.has(x)).sort();
  if (onlyA.length || onlyB.length) {
    fail(label);
    if (onlyA.length) console.error(`    仅 ${aName} 有: ${onlyA.join(', ')}`);
    if (onlyB.length) console.error(`    仅 ${bName} 有: ${onlyB.join(', ')}`);
  } else {
    ok(`${label}（${a.size} 项）`);
  }
};

// ① 路由表 vs manifest
const routeActions = new Set([...serverTs.matchAll(/case '([A-Za-z]+)'/g)].map((m) => m[1]));
const manifestActions = new Set(Object.keys(manifest.actions));
diff('server.ts 路由表 == manifest actions', routeActions, manifestActions, 'server.ts', 'manifest');

// ② Java 镜像方法调用点 vs manifest
//    调用点形态：client.call("x" / jsonCall("x" / voidCall("x" / pluginCall(action 变量由重载传入，另抓 pluginCall("x"
const javaActionRe = /(?:client\.call|jsonCall|voidCall|pluginCall)\(\s*"([A-Za-z]+)"/g;
const javaActions = new Set([
  ...[...semaCoreJava.matchAll(javaActionRe)].map((m) => m[1]),
  ...[...semaSessionJava.matchAll(javaActionRe)].map((m) => m[1]),
]);
diff('Java SemaCore/SemaSession 镜像方法 == manifest actions', javaActions, manifestActions, 'Java', 'manifest');

// ③ Java 事件常量 vs manifest 事件
const javaEvents = new Set([...semaEventsJava.matchAll(/=\s*"([a-zA-Z:]+)"/g)].map((m) => m[1]));
const manifestEvents = new Set([
  ...manifest.events.session,
  ...manifest.events.process,
  ...Object.keys(manifest.events.synthetic),
]);
diff('Java SemaEvents 常量 == manifest 事件清单', javaEvents, manifestEvents, 'Java', 'manifest');

// ④ Python 镜像方法调用点 vs manifest（api.py：call/_json/_call/_plugin 的字符串字面量）
const pyActionRe = /(?:\bcall|_json|_call|_plugin)\(\s*"([A-Za-z]+)"/g;
const pyActions = new Set([...apiPy.matchAll(pyActionRe)].map((m) => m[1]));
diff('Python SemaCore/SemaSession 镜像方法 == manifest actions', pyActions, manifestActions, 'Python', 'manifest');

// ⑤ Python 事件常量 vs manifest 事件
const pyEvents = new Set([...eventsPy.matchAll(/=\s*"([a-zA-Z:]+)"/g)].map((m) => m[1]));
diff('Python events.py 常量 == manifest 事件清单', pyEvents, manifestEvents, 'Python', 'manifest');

// ⑥ C# 镜像方法调用点 vs manifest
//    调用点形态：client.Call("x" / _client.Call("x" / JsonCall("x" / VoidCall("x" / PluginCall("x"
const csActionRe = /(?:client\.Call|JsonCall|VoidCall|PluginCall)\(\s*"([A-Za-z]+)"/g;
const csActions = new Set([
  ...[...semaCoreCs.matchAll(csActionRe)].map((m) => m[1]),
  ...[...semaSessionCs.matchAll(csActionRe)].map((m) => m[1]),
]);
diff('C# SemaCore/SemaSession 镜像方法 == manifest actions', csActions, manifestActions, 'C#', 'manifest');

// ⑦ C# 事件常量 vs manifest 事件
const csEvents = new Set([...semaEventsCs.matchAll(/=\s*"([a-zA-Z:]+)"/g)].map((m) => m[1]));
diff('C# SemaEvents 常量 == manifest 事件清单', csEvents, manifestEvents, 'C#', 'manifest');

// ⑧ 协议版本五处一致
const serverVersion = Number(serverTs.match(/const PROTOCOL_VERSION = (\d+)/)?.[1] ?? NaN);
const javaVersion = Number(semaConstantsJava.match(/PROTOCOL_VERSION = (\d+)/)?.[1] ?? NaN);
const pyVersion = Number(constantsPy.match(/PROTOCOL_VERSION = (\d+)/)?.[1] ?? NaN);
const csVersion = Number(semaConstantsCs.match(/PROTOCOL_VERSION = (\d+)/)?.[1] ?? NaN);
if (manifest.protocolVersion === serverVersion && serverVersion === javaVersion
    && javaVersion === pyVersion && pyVersion === csVersion) {
  ok(`协议版本一致（v${serverVersion}：manifest / server.ts / Java / Python / C#）`);
} else {
  fail(`协议版本漂移：manifest=${manifest.protocolVersion} server.ts=${serverVersion} Java=${javaVersion} Python=${pyVersion} C#=${csVersion}`);
}

process.exit(failed ? 1 : 0);
