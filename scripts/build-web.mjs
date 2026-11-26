// Builds the single-file site: web/app.js (+ viem) bundled by esbuild and inlined into web/index.html,
// with the IBM Plex fonts embedded (no outside requests for page assets).
//   node scripts/build-web.mjs              → public/index.html (Cloudflare site; config deployments/web-config.json or WEB_CONFIG)
//   ONCHAIN=1 node scripts/build-web.mjs    → public-onchain/index.html for DeWEB: TapeKit's default X Layer nodes only,
//                                              no OKX Connect (its relay is off-chain), icon inlined, checked against
//                                              TapeKit's "100% on-chain" static rule.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkOnchain } from './check-onchain.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ONCHAIN = process.env.ONCHAIN === '1';
const cfgPath = process.env.WEB_CONFIG || path.join(root, 'deployments/web-config.json');
const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
for (const k of ['chainId', 'rpc', 'explorer', 'factory', 'usdt', 'wokb', 'pool', 'processor', 'circuitId', 'repo']) {
  if (config[k] === undefined || config[k] === '') throw new Error(`web config is missing "${k}" (${cfgPath})`);
}
if (ONCHAIN) {
  config.rpc = ['https://rpc.xlayer.tech', 'https://xlayer.drpc.org']; // TapeKit's default X Layer nodes (allowed on the gateway)
  config.onchain = true;
  delete config.wcProjectId;
  delete config.keeperUrl;
}
const stub = {
  name: 'okx-stub',
  setup(b) {
    b.onResolve({ filter: /^@okxconnect\/universal-provider$/ }, () => ({ path: path.join(root, 'web/okx-stub.js') }));
    b.onResolve({ filter: /^@walletconnect\/universal-provider$/ }, () => ({ path: path.join(root, 'web/wc-stub.js') }));
  }
};
const res = await build({
  entryPoints: [path.join(root, 'web/app.js')], bundle: true, minify: true, format: 'iife',
  target: ['es2020'], write: false, legalComments: 'none', plugins: ONCHAIN ? [stub] : []
});
const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const font = (pkg, file, family, weight) => {
  const b64 = fs.readFileSync(path.join(root, 'node_modules/@fontsource', pkg, 'files', file)).toString('base64');
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format("woff2")}`;
};
const fonts = [400, 500, 600, 700].map((w) => font('ibm-plex-sans', `ibm-plex-sans-latin-${w}-normal.woff2`, 'IBM Plex Sans', w))
  .concat([400, 500].map((w) => font('ibm-plex-mono', `ibm-plex-mono-latin-${w}-normal.woff2`, 'IBM Plex Mono', w))).join('');
const icon = ONCHAIN ? 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'web/icon.png')).toString('base64') : 'icon.png';

const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8')
  .replace('__FONTS__', () => fonts)
  .replace('__ICON__', icon)
  .replace('__CONFIG__', JSON.stringify(config))
  .replace('__APP__', () => js);
const outDir = path.join(root, ONCHAIN ? 'public-onchain' : 'public');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), html);
if (ONCHAIN) {
  const hits = checkOnchain(html);
  if (hits.length) { for (const h of hits.slice(0, 20)) console.error(`  off-chain ${h.where}: ${h.url}`); throw new Error(`not on-chain pure: ${hits.length} off-chain reference(s)`); }
  console.log(`public-onchain/index.html written (${(html.length / 1024).toFixed(0)} KiB), on-chain pure (TapeKit static rule)`);
} else {
  fs.copyFileSync(path.join(root, 'web/icon.png'), path.join(outDir, 'icon.png'));
  fs.rmSync(path.join(outDir, 'v1.html'), { force: true });
  console.log(`public/index.html written (${(html.length / 1024).toFixed(0)} KiB) for factory ${config.factory}`);
}
