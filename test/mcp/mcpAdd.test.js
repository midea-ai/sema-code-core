const { SemaCore } = require('../../dist/core/SemaCore');

const core = new SemaCore({ logLevel: 'none' });

const testMCPConfig = {
  name: 'sequential-thinking',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
};

async function run() {
  await core.createSession();
  await core.addOrUpdateMCPServer(testMCPConfig, 'project');

  const allConfigs = core.getMCPServerConfigs();
  console.log('project 配置:', JSON.stringify(allConfigs.get('project') || [], null, 2));
  console.log('user 配置:', JSON.stringify(allConfigs.get('user') || [], null, 2));
}

run()
  .then(async () => { await core.dispose(); process.exit(0); })
  .catch(async (err) => { console.error(err); await core.dispose(); process.exit(1); });
