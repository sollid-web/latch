// Builds the single-file site: web/app.js (+ viem) bundled by esbuild and inlined into
// web/index.html → public/index.html. Config comes from deployments/web-config.json, or the
// path in WEB_CONFIG.   Usage: node scripts/build-web.mjs
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfgPath = process.env.WEB_CONFIG || path.join(root, 'deployments/web-config.json');
const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
for (const k of ['chainId', 'rpc', 'explorer', 'factory', 'usdt', 'wokb', 'pool', 'processor', 'circuitId', 'repo']) {
  if (config[k] === undefined || config[k] === '') throw new Error(`web config is missing "${k}" (${cfgPath})`);
}
const res = await build({
  entryPoints: [path.join(root, 'web/app.js')], bundle: true, minify: true, format: 'iife',
  target: ['es2020'], write: false, legalComments: 'none'
});
const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8')
  .replace('__CONFIG__', JSON.stringify(config))
  .replace('__APP__', () => js);
fs.mkdirSync(path.join(root, 'public'), { recursive: true });
fs.writeFileSync(path.join(root, 'public/index.html'), html);
// The old relay console (v1.html) is retired; remove any copy left from earlier builds.
fs.rmSync(path.join(root, 'public/v1.html'), { force: true });
console.log(`public/index.html written (${(html.length / 1024).toFixed(0)} KiB) for factory ${config.factory}`);
