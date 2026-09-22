import type { RunShellGateVerdict } from '../../src/manager/runShellGate'

// run_shell 前置闸门的用例表：命令 → 期望的确定性结论。
//  allow → 直接放行（只读白名单/已存授权）
//  model → 交 AutoRun 模型（非 AutoRun 档转人工）
//  human → 确定性转人工，不调模型
// 相对路径按 process.cwd()（项目根）解析，用例须在仓库根目录下运行。
export interface GateCase { name: string; command: string; expect: RunShellGateVerdict }

export const GATE_CASES: GateCase[] = [
  // ---------- 只读白名单 ----------
  { name: 'git status', command: 'git status', expect: 'allow' },
  { name: '只读管道', command: "ls -la | grep -i 'x'", expect: 'allow' },
  { name: 'cat 项目外文件（读由 view_file 规则管，shell 只读白名单直接放行）', command: 'cat /etc/hosts', expect: 'allow' },

  // ---------- 未覆盖 → 交模型 ----------
  { name: '构建命令', command: 'npm run build', expect: 'model' },
  { name: '环回 POST', command: `curl -s -X POST http://localhost:1/api/items -d '{"name":"test"}'`, expect: 'model' },
  { name: '环回破坏性路径（由模型判 risky）', command: 'curl -s -X POST http://localhost:1/admin/reset', expect: 'model' },
  {
    name: '>300 字符的 python -c',
    command: `python3 -c "import os; d='/tmp/probe_long'; os.makedirs(d, exist_ok=True); open(d+'/a.txt','w').write('a'*10); open(d+'/b.txt','w').write('b'*10); open(d+'/c.txt','w').write('c'*10); open(d+'/d.txt','w').write('d'*10); open(d+'/e.txt','w').write('e'*10); open(d+'/f.txt','w').write('f'*10); print(sorted(os.listdir(d)))"`,
    expect: 'model',
  },

  // ---------- 灰区危险命令 → 交模型 ----------
  { name: 'cd 临时目录后相对 rm（cd 跟踪）', command: `cd /tmp && rm -rf recalc_x && mkdir recalc_x && cd recalc_x && unzip -o -q /tmp/recalc.xlsx && grep -o '<c r="[CD][0-9]*"[^/]*>.\\{0,400\\}' xl/worksheets/sheet4.xml | head -6`, expect: 'model' },
  { name: '项目内 chmod', command: 'touch probe_chmod.sh && chmod +x probe_chmod.sh && ls -l probe_chmod.sh', expect: 'model' },
  { name: '项目内删除单文件', command: 'rm probe_chmod.sh', expect: 'model' },
  { name: '删除可再生产物', command: 'mkdir -p probe_dist && touch probe_dist/a.js && rm -rf probe_dist', expect: 'model' },
  { name: '项目内大范围删除（由模型判 risky）', command: 'rm -rf src', expect: 'model' },
  { name: 'pkill 自启进程', command: 'pkill -f "sleep 300"', expect: 'model' },
  { name: 'kill -9 1（由模型判 risky）', command: 'kill -9 1', expect: 'model' },
  { name: 'find -delete 项目内', command: "find . -name '*.pyc' -delete", expect: 'model' },
  { name: 'cd 相对子目录后 rm', command: 'cd packages/app && rm -rf dist', expect: 'model' },
  { name: '; 拼接 source + 测试', command: 'source venv/bin/activate; pytest -q', expect: 'model' },

  // ---------- 注入形态（$() / ; / for / heredoc 后接命令）→ 交模型 ----------
  { name: '只读 $() 替换', command: 'echo $(id)', expect: 'model' },
  { name: 'kill $(lsof)', command: 'kill $(lsof -t -i:3000)', expect: 'model' },
  {
    name: 'for 循环 mv 变量（slides 改名）',
    command: `cd slides && for n in 12 11 10 9 8 7 6 5 4; do m=$((n+1)); a=$(printf "slide-%02d.js" $n); b=$(printf "slide-%02d.js" $m); mv "$a" "$b"; done && ls slide-*.js`,
    expect: 'model',
  },
  {
    name: 'heredoc 后接 cat',
    command: `cd /tmp/sr && python3 - <<'EOF'
import re
x=open('word/styles.xml',encoding='utf-8').read()
print("STYLE IDS:", re.findall(r'w:styleId="([^"]+)"', x))
EOF
echo "=== header1 ==="; cat /tmp/sr/word/header1.xml; echo; echo "=== footer1 ==="; cat /tmp/sr/word/footer1.xml`,
    expect: 'model',
  },
  {
    name: '临时目录 rm + soffice + for $()（r1b/r2b）',
    command: `cd /tmp && rm -rf /tmp/r1b /tmp/r2b && mkdir -p /tmp/r1b /tmp/r2b && soffice --headless --convert-to pdf --outdir /tmp/r1b /tmp/pass1.docx >/dev/null 2>&1; soffice --headless --convert-to pdf --outdir /tmp/r2b /Users/dev/Documents/Sema/test/sales_report.docx >/dev/null 2>&1; for f in /tmp/render/pass1.pdf /tmp/r1b/pass1.pdf /tmp/render2/sales_report.pdf /tmp/r2b/sales_report.pdf; do echo "$f: $(pdfinfo $f | grep -i '^Pages')"; done`,
    expect: 'model',
  },
  {
    name: 'cd 项目外 + $(npm root -g) + heredoc（pptx 编译）',
    command: `cd /Users/dev/Documents/Sema/test/slides && NODE_PATH=$(npm root -g) node compile.js >/dev/null && python3 postprocess.py output/sales_review.pptx output/sales_review.pptx && cp output/sales_review.pptx ../sales_review.pptx && python3 - <<'PY'
import zipfile, re
z = zipfile.ZipFile("output/sales_review.pptx")
def num(n): return int(re.search(r"(\\d+)", n).group(1))
slides = sorted([n for n in z.namelist() if re.match(r"ppt/slides/slide\\d+\\.xml$", n)], key=num)
print("slides", len(slides))
for i, n in enumerate(slides, 1):
    txt = "".join(re.findall(r"<a:t>([^<]*)</a:t>", z.read(n).decode()))
    p = f"第 {i} 页 / 共 13 页" in txt
    print(f"{i:2d} 页码={p}")
PY`,
    expect: 'model',
  },
  {
    name: '临时目录 python 转换 + rm + for $()（docx 转换）',
    command: `cd /tmp && python3 /tmp/sr_transform.py /tmp/sales_report.orig.docx /tmp/p1c.docx >/dev/null && python3 /tmp/sr_transform.py /tmp/sales_report.orig.docx /tmp/p2c.docx /tmp/pages.json >/dev/null && rm -rf /tmp/rc && mkdir -p /tmp/rc && soffice --headless --convert-to pdf --outdir /tmp/rc /tmp/p1c.docx /tmp/p2c.docx >/dev/null 2>&1; for f in /tmp/rc/p1c.pdf /tmp/rc/p2c.pdf; do echo "$f: $(pdfinfo $f|grep -i '^Pages')"; done`,
    expect: 'model',
  },

  // ---------- 硬边界 → 确定性转人工 ----------
  { name: 'sudo', command: 'sudo ls /', expect: 'human' },
  { name: 'chmod 项目外', command: 'chmod +x ~/probe_not_exist.sh', expect: 'human' },
  { name: 'chmod 系统目录', command: 'chmod -R 777 /usr/local', expect: 'human' },
  { name: 'rm 项目外', command: 'rm -rf ~/nonexistent_probe_dir', expect: 'human' },
  { name: 'rm .git', command: 'rm -rf .git', expect: 'human' },
  { name: 'rm 项目根', command: 'rm -rf .', expect: 'human' },
  { name: '|| 后 cd 不可跟踪', command: 'cd /tmp || rm -rf probe_cd', expect: 'human' },
  { name: 'cd 变量后相对 rm', command: 'cd $DIR && rm -rf dist', expect: 'human' },
  { name: '; 拼接的字面项目外删除', command: 'cat x; rm -rf ~/Documents', expect: 'human' },
  { name: 'eval', command: 'echo hi; eval "$cmd"', expect: 'human' },
  { name: 'find -exec sh -c', command: "find . -name '*.log' -exec sh -c 'rm {}' \\;", expect: 'human' },
  { name: '$() 内层 sudo', command: 'echo $(sudo id)', expect: 'human' },
  { name: '反引号', command: 'echo `id`', expect: 'human' },
  { name: 'heredoc 后接 sudo', command: `python3 - <<'EOF'
print(1)
EOF
sudo ls /`, expect: 'human' },
  { name: 'nc 裸 socket', command: 'nc -zv localhost 3000', expect: 'human' },
  { name: 'dd', command: 'dd if=/dev/zero of=/tmp/x bs=1m count=1', expect: 'human' },
]
