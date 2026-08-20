import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
};
const entries = [
  { entryPoints: ['src/index.ts'], outfile: 'dist/index.js' },
  { entryPoints: ['src/workers/entry.ts'], outfile: 'dist/worker-entry.js' },
];

if (watch) {
  for (const e of entries) (await context({ ...common, ...e })).watch();
} else {
  for (const e of entries) await build({ ...common, ...e });
}
