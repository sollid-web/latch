// UI end-to-end test (dev only). Three terminals' worth of steps, from the repo root:
//   1. node web/e2e-setup.mjs                                   (local chain; prints READY, keep it running)
//   2. WEB_CONFIG=<tmp>/latch-ui/web-local.json node scripts/build-web.mjs
//   3. node web/e2e.mjs                                         (needs Playwright: npm i -g playwright, or PLAYWRIGHT=/path/to/playwright)
// UI_DIR overrides <tmp>/latch-ui; CHROME=/path/to/chrome picks a browser binary.
// Drives the real page with a mock OKX wallet: connect → create DCA vault → deposit → hosted bot buys →
// dashboard shows the buy, rule chip, spacing → pause → withdraw all → mobile layout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const R = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = process.env.UI_DIR || path.join(os.tmpdir(), 'latch-ui');
const pwPath = process.env.PLAYWRIGHT || (() => {
  try { return createRequire(import.meta.url).resolve('playwright'); } catch { /* not local */ }
  try { return createRequire(path.join(process.execPath, '..', '..', 'lib', 'node_modules', 'x.js')).resolve('playwright'); } catch { return 'playwright'; }
})();
const { chromium } = (await import(pwPath.startsWith('/') ? pathToFileURL(pwPath).href : pwPath)).default;
const cfg = JSON.parse(fs.readFileSync(path.join(UI, 'web-local.json'), 'utf8'));
const { runOnce } = await import('../keeper-worker/src/keeper.js');
const shots = path.join(UI, 'shots'); fs.mkdirSync(shots, { recursive: true });
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
// Mock OKX wallet: forwards every request to the local chain, which signs as the user (auto-impersonate).
await ctx.addInitScript(({ rpc, user }) => {
  const call = async (method, params) => {
    const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json(); if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; } return j.result;
  };
  window.okxwallet = {
    isOkxWallet: true,
    request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [user];
      if (method === 'eth_chainId') return '0xc4';
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'eth_sendTransaction') { params[0].from = user; }
      return call(method, params || []);
    },
    on() {}
  };
  window.confirm = () => true;
  window.prompt = (q, d) => (/How much/.test(q) ? '5' : /hours/.test(q) ? '24' : d);
}, { rpc: cfg.rpc[0], user: cfg.user });
const page = await ctx.newPage();
const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) process.exitCode = 1; };
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(pathToFileURL(path.join(R, 'public/index.html')).href); await page.waitForTimeout(1500);
await page.screenshot({ path: shots + '/1-landing.png' });
await page.click('.pin >> nth=3'); await page.waitForTimeout(200);
ok('flipping a rule makes the chip block', /Blocked/.test(await page.evaluate(() => document.querySelector('.verdict').innerText)));
await page.click('[data-a=askChip]'); await page.waitForTimeout(1500);
ok('real chip on chain agrees (no)', /Chain says: no/.test(await page.evaluate(() => document.querySelector('.verdict').innerText)));
await page.screenshot({ path: shots + '/1b-chip-blocked.png' });
await page.click('.pin >> nth=3'); await page.waitForTimeout(200);
const txt = () => page.evaluate(() => document.body.innerText);
await page.click('text=Connect wallet'); await page.waitForTimeout(1500);
ok('connected and sees empty dashboard', /No vault yet/.test(await txt()));
await page.click('.hero [data-a=wizard]'); await page.waitForTimeout(300);
await page.click('.sheet [data-v=dca]'); await page.click('.sheet [data-a=next]');
await page.fill('#f-perBuy', '2'); await page.selectOption('#f-every', '86400'); await page.fill('#f-price', '150');
await page.screenshot({ path: shots + '/2-settings.png' });
await page.click('.sheet [data-a=next]'); await page.waitForTimeout(200);
ok('review sentence in plain words', /buys 2 USDT0 of OKB every day/.test(await txt()));
await page.screenshot({ path: shots + '/3-review.png' });
await page.click('[data-a=create]'); await page.waitForTimeout(4000);
ok('vault created, deposit step shown', /Your vault is live/.test(await txt()));
await page.fill('#f-deposit', '10'); await page.click('[data-a=deposit]'); await page.waitForTimeout(5000);
const t1 = await txt();
ok('dashboard shows the vault with 10 USDT0', /Auto-DCA/.test(t1) && /10\.00/.test(t1));
ok('ready to buy (all checks pass)', /Buying/.test(t1));
await page.screenshot({ path: shots + '/4-dashboard-ready.png', fullPage: true });
// hosted bot runs
const r = await runOnce({ KEEPER_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', RPC_URL: cfg.rpc[0], FACTORY_ADDRESS: cfg.factory }, { send: true, wait: true, prices: [{ venue: 'a', ok: true, price: 78.5 }, { venue: 'b', ok: true, price: 78.4 }] });
ok('hosted bot bought', (r.vaults || []).some((v) => v.action === 'bought'));
await page.click('[data-a=refresh] >> nth=0'); await page.waitForTimeout(4000);
await page.evaluate(() => document.querySelectorAll('details').forEach((d) => d.open = true));
const t2 = await txt();
ok('dashboard: 1 buy, OKB bought, avg price ~78', /Average price \(before fee\)\s*7[89]\./.test(t2));
ok('next buy is tomorrow (spacing)', /Next buy in/.test(t2));
ok('rule chip line shown', /TapeOut circuit #1 says/.test(t2));
ok('recent buys table shows the buy', /Received/.test(t2) && /WOKB/.test(t2) && !/could not be loaded/.test(t2));
ok('latest-buys feed shows the buy', /Latest buys on X Layer/.test(t2));
ok('chip line explains why it says no', /today\u2019s buy is done/.test(t2));
await page.screenshot({ path: shots + '/5-after-buy.png', fullPage: true });
await page.click('[data-a=pause]'); await page.waitForTimeout(4000);
ok('pause works', /Paused/.test(await txt()));
await page.click('[data-a=withdraw]'); await page.waitForTimeout(300); await page.screenshot({ path: shots + '/5b-withdraw-dialog.png' }); await page.click('.sheet [type=submit]'); await page.waitForTimeout(4000);
const t3 = await txt();
ok('withdraw all works (0.00 left)', /USDT0 left\s*0\.00/i.test(t3));
await page.screenshot({ path: shots + '/6-withdrawn.png', fullPage: true });
await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
await page.screenshot({ path: shots + '/7-mobile.png', fullPage: true });
ok('no page errors', errs.length === 0); if (errs.length) console.log(errs);
// Phone browser with no wallet: Connect shows the phone steps, and "Open in OKX app" is OKX's https universal link.
{
  const m = await b.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  let opened = null;
  await m.route('https://web3.okx.com/**', (route) => { opened = route.request().url(); route.abort(); });
  const mp = await m.newPage();
  await mp.goto(pathToFileURL(path.join(R, 'public/index.html')).href); await mp.waitForTimeout(1000);
  const pageUrl = mp.url();
  await mp.click('text=Connect wallet'); await mp.waitForTimeout(4000);
  ok('phone: Connect shows the steps with Copy link', /Copy link/.test(await mp.evaluate(() => document.body.innerText)));
  await mp.click('a:has-text("Open in OKX app")'); await mp.waitForTimeout(1500);
  const inner = opened ? new URL(opened).searchParams.get('deeplink') : null; // okx://wallet/dapp/url?dappUrl=<encoded page>
  ok('phone: Open in OKX app uses the universal link to this page', !!opened && opened.startsWith('https://web3.okx.com/download?deeplink=')
    && /^okx:\/\/wallet\/dapp\/url\?dappUrl=/.test(inner || '') && decodeURIComponent(inner.split('dappUrl=')[1] || '') === pageUrl);
  await m.close();
}
await b.close();
