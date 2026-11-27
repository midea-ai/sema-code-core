import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT_DIR = path.resolve(__dirname, '../..');

function evalRoot(env: Record<string, string | undefined>): { root: string; stderr: string } {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if ('SEMA_ROOT' in env) {
    if (env.SEMA_ROOT === undefined) delete childEnv.SEMA_ROOT;
    else childEnv.SEMA_ROOT = env.SEMA_ROOT;
  }
  const script = `
    const { SemaCore } = require('./src/index.ts');
    process.stdout.write(SemaCore.getSemaRootDir());
  `;
  const res = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: ROOT_DIR,
    env: childEnv,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  return { root: res.stdout, stderr: res.stderr };
}

const DEFAULT_ROOT = path.join(os.homedir(), '.sema');

test('SemaCore.getSemaRootDir 缺省为 ~/.sema', () => {
  const res = evalRoot({ SEMA_ROOT: undefined });
  assert.equal(res.root, DEFAULT_ROOT);
  assert.equal(res.stderr, '');
});

test('SemaCore.getSemaRootDir 忽略纯空白 SEMA_ROOT 并回落 ~/.sema', () => {
  const res = evalRoot({ SEMA_ROOT: '   ' });
  assert.equal(res.root, DEFAULT_ROOT);
  assert.equal(res.stderr, '');
});

test('SemaCore.getSemaRootDir 展开 SEMA_ROOT 中的 ~/ 子路径', () => {
  const custom = evalRoot({ SEMA_ROOT: '~/.sema-custom' });
  assert.equal(custom.root, path.join(os.homedir(), '.sema-custom'));
  assert.equal(custom.stderr, '');

  const nested = evalRoot({ SEMA_ROOT: '~/a/b' });
  assert.equal(nested.root, path.join(os.homedir(), 'a', 'b'));
  assert.equal(nested.stderr, '');
});

test('SemaCore.getSemaRootDir 支持自定义绝对路径并 trim 首尾空白', () => {
  const target = path.join(os.tmpdir(), 'sema-root-test');
  const res = evalRoot({ SEMA_ROOT: `  ${target}  ` });
  assert.equal(res.root, path.resolve(target));
  assert.equal(res.stderr, '');
});

test('SemaCore.getSemaRootDir 拒绝相对路径，打印警告并回落 ~/.sema', () => {
  for (const invalid of ['./sema-local', '../sema-local', 'sema-local', '~other/sema']) {
    const res = evalRoot({ SEMA_ROOT: invalid });
    assert.equal(res.root, DEFAULT_ROOT, `expected fallback for ${invalid}`);
    assert.match(res.stderr, /SEMA_ROOT/, `expected warning for ${invalid}`);
  }
});

test('SemaCore.getSemaRootDir 拒绝单独的 ~ 及指向家目录本身的 ~/ 变体，打印警告并回落 ~/.sema', () => {
  for (const invalid of ['~', '~/', '~///', '~/.', '~/./', '~/sub/..']) {
    const res = evalRoot({ SEMA_ROOT: invalid });
    assert.equal(res.root, DEFAULT_ROOT, `expected fallback for ${invalid}`);
    assert.match(res.stderr, /SEMA_ROOT/, `expected warning for ${invalid}`);
  }
});
