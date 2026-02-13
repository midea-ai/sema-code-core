const readline = require('readline');
const { SemaCore } = require('../dist/core/SemaCore');

const core = new SemaCore({
  workingDir: '/path/to/your/project', // 修改为你的项目路径
  logLevel: 'none',
  thinking: false,
  useTools: []
});

core.on('message:text:chunk', (data) => process.stdout.write(data.delta));
core.on('state:update', (data) => {
  if (data.state === 'idle') {
    process.stdout.write('\n');
    prompt();
  }
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function prompt() {
  rl.question('> ', (input) => {
    input = input.trim();
    if (input === 'exit' || input === 'quit') {
      rl.close();
      process.exit(0);
    }
    if (input) core.processUserInput(input);
    else prompt();
  });
}

async function run() {
  const ready = new Promise((resolve) => core.once('session:ready', resolve));
  await core.createSession();
  await ready;
  prompt();
}

run().catch((e) => { console.error(e); process.exit(1); });
