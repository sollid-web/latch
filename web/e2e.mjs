// UI end-to-end test (dev only), from the repo root:
//   1. node web/e2e-setup.mjs                                   (local chain with v1 + v2 contracts; prints READY, keep it running)
//   2. WEB_CONFIG=<tmp>/latch-ui/web-local.json node scripts/build-web.mjs
//   3. node web/e2e.mjs                                         (needs Playwright: npm i -g playwright, or PLAYWRIGHT=/path/to/playwright)
// UI_DIR overrides <tmp>/latch-ui; CHROME=/path/to/chrome picks a browser binary.
// Drives the real page with a mock OKX wallet through every page: Home chip → create a Buy vault (smart) →
// fund → hosted bot buys 3× → create a Take Profit vault (ladder) → fund → bot sells → change strategy →
// pause → withdraw → The chip, Activity, Safety → phone layout.
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
await ctx.addInitScript(({ rpc, user }) => { // mock OKX wallet: the local chain signs as the user (auto-impersonate)
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
      if (method === 'eth_sendTransaction') {
        params[0].from = user;
        // like the OKX app on X Layer: a plain USDT0 transfer goes through its free-gas service, which can fail
        if (window.__freeGasDown && String(params[0].data || '').startsWith('0xa9059cbb') && !params[0].gas) { const e = new Error('Network error, try again later'); e.code = -32603; throw e; }
      }
      return call(method, params || []);
    },
    on() {}
  };
}, { rpc: cfg.rpc[0], user: cfg.user });
const page = await ctx.newPage();
const ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !extra ? '' : '  → ' + String(extra).slice(0, 300))); if (!c) process.exitCode = 1; };
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
const txt = () => page.evaluate(() => document.querySelector('main').innerText);
const url = pathToFileURL(path.join(R, 'public/index.html')).href;
const go = async (h, wait = 1200) => { await page.evaluate((x) => { location.hash = x; }, h); await page.waitForTimeout(wait); };
const botEnv = { KEEPER_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', RPC_URL: cfg.rpc[0], FACTORY_ADDRESS: cfg.factory, FACTORY2_ADDRESS: cfg.factory2, CHAIN_ID: '196' };
const P = (x) => [{ venue: 'A', ok: true, price: x }, { venue: 'B', ok: true, price: x + 0.1 }];
const verdict = () => page.evaluate(() => document.querySelector('.verdict').innerText);

/* ---- Home + chip ---- */
await page.goto(url); await page.waitForTimeout(2000);
await page.screenshot({ path: shots + '/1-home.png', fullPage: true });
ok('home: headline + two jobs', /Buy OKB on dips\. Take profit on rises/.test(await txt()) && /Two jobs, one vault each/.test(await txt()));
ok('home chip: smart, 10–15% dip, calm → Buy 2×', /Buy 2×/.test(await verdict()), await verdict());
await page.click('[data-a=askChip]'); await page.waitForTimeout(1500);
ok('real chip on chain agrees (buy 2×)', /Chain says: buy 2×/.test(await verdict()), await verdict());
await page.click('[data-a=x][data-k=vol][data-v="3"]'); await page.waitForTimeout(200);
ok('very jumpy → Wait', /^Wait/.test(await verdict()), await verdict());
await page.click('[data-a=x][data-k=vol][data-v="0"]');
await page.locator('[data-a=xr]').fill('6'); await page.waitForTimeout(200);
ok('slider to 30–40% → Buy 3×', /Buy 3×/.test(await verdict()), await verdict());

/* ---- Try it (no wallet): live pool + real chip ---- */
await go('#/try', 2500);
const tv = () => page.evaluate(() => document.querySelector('.try .verdict').innerText);
ok('try: smart buy with reference 12% above the price → Buy 2× · 4 USDT0', /Buy 2× · 4 USDT0/.test(await tv()), await tv());
await page.click('[data-a=tAsk]'); await page.waitForTimeout(1500);
ok('try: real chip agrees', /Chain says: buy 2×/.test(await tv()), await tv());
await page.click('[data-a=t][data-k=dir][data-v="1"]'); await page.waitForTimeout(300);
ok('try: take profit with reference 10% under → Sell 2×', /Sell 2× · 0\.04 OKB/.test(await tv()), await tv());
await page.fill('#t-limit', '90'); await page.locator('#t-limit').dispatchEvent('change'); await page.waitForTimeout(300);
ok('try: floor above the price → Wait, with the reason', /^Wait/.test(await tv()) && /under your floor/.test(await tv()), await tv());
await page.screenshot({ path: shots + '/1b-try.png', fullPage: true });
await page.click('[data-a=tCreate]'); await page.waitForTimeout(500);
ok('try → Create carries the settings', /Take profit automatically/.test(await txt()), (await txt()).slice(0, 200));

/* ---- Create a Buy vault (smart, reference 100 → OKB ~21% below → 3×) ---- */
ok('wallet that already approved the site shows connected on load, no prompt', !(await page.locator('header [data-a=connect]').count()) && /0x/i.test(await page.locator('header').innerText()), await page.locator('header').innerText());
await page.click('header [data-a=disconnect]'); await page.waitForTimeout(800);
ok('Disconnect → Connect wallet button again', (await page.locator('header [data-a=connect]').count()) === 1);
await page.reload(); await page.waitForTimeout(2500);
ok('after Disconnect, a reload stays disconnected (no silent reconnect)', (await page.locator('header [data-a=connect]').count()) === 1);
await page.click('header [data-a=connect]'); await page.waitForTimeout(600);
const pick = await page.locator('.picker').innerText().catch(() => '');
ok('Connect opens the wallet picker: browser wallet + scan with a phone wallet', /Connect a wallet/.test(pick) && /OKX Wallet/.test(pick) && /Scan with a phone wallet/.test(pick) && /X Layer/.test(pick), pick);
await page.screenshot({ path: shots + '/1c-wallet-picker.png' });
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
ok('Escape closes the picker without connecting (only a non-clickable fading copy may linger outside the app)', !(await page.locator('#app .picker').count()) && (await page.locator('.picker').evaluateAll((els) => els.every((e) => e.closest('.lg-ghost') && e.closest('[inert]')))) && (await page.locator('header [data-a=connect]').count()) === 1);
await page.click('header [data-a=connect]'); await page.waitForTimeout(400);
await page.click('.picker [data-a=pick][data-id^="inj:"]'); await page.waitForTimeout(1500);
ok('picking the browser wallet connects and closes the picker', !(await page.locator('.picker').count()) && /0x/i.test(await page.locator('header').innerText()), await page.locator('header').innerText());
await go('#/create?buy', 600);
ok('create: Buy preset opens on Strategy', /Buy OKB automatically/.test(await txt()) && /Smart/.test(await txt()));
await page.screenshot({ path: shots + '/2-create-strategy.png', fullPage: true });
await page.click('[data-a=cmode][data-v="2"]'); await page.click('[data-a=cnext]'); await page.waitForTimeout(200);
await page.fill('#c-ref', '100'); await page.fill('#c-base', '2'); await page.locator('#c-base').dispatchEvent('change'); await page.waitForTimeout(200);
ok('limits suggested from strategy (3 × base = 6)', (await page.inputValue('#c-perTx')) === '6' && (await page.inputValue('#c-daily')) === '6', await page.inputValue('#c-perTx'));
await page.screenshot({ path: shots + '/3-create-amounts.png', fullPage: true });
await page.click('[data-a=cnext]'); await page.waitForTimeout(300);
const review = await txt();
ok('review sentence in plain English', /Latch buys 2 USDT0 of OKB at most once a day, rising to 4 USDT0 when OKB is 10% or more below 100\.00, 6 USDT0 when OKB is 20% or more below 100\.00/.test(review), review.split('\n').find((l) => /Latch buys/.test(l)));
await page.screenshot({ path: shots + '/4-create-review.png', fullPage: true });
await page.click('[data-a=ccreate]'); await page.waitForTimeout(2500);
ok('vault created → Add funds step', /Your vault is live/.test(await txt()), (await txt()).slice(0, 300));
await page.fill('#c-deposit', '99999999'); await page.click('[data-a=cdeposit]'); await page.waitForTimeout(800);
ok('Add funds: more than the wallet holds is refused plainly, before the wallet opens', /Your wallet holds [\d.,]+ USDT0, less than the 99999999 you entered/.test(await txt()) && (await page.evaluate(() => location.hash)) !== '#/vaults' && /Your vault is live/.test(await txt()), (await txt()).slice(0, 400));
await page.fill('#c-deposit', '20'); await page.click('[data-a=cdeposit]'); await page.waitForFunction(() => location.hash === '#/vaults', null, { timeout: 20000 }).catch(() => {}); await page.waitForTimeout(2500);
ok('after funding: on My vaults with the Buy vault', /My vaults/.test(await txt()) && /Buy OKB · Smart/.test(await txt()), (await txt()).slice(0, 300));
ok('My vaults: chip decision shows buy 3×', /buy 3×/.test(await txt()), (await txt()).match(/Decision[^\n]*\n[^\n]*/)?.[0]);

/* ---- Hosted bot trades ---- */
let r = await runOnce(botEnv, { send: true, wait: true, prices: P(78.5) });
const row = (x) => r.vaults.find((v) => v.version === 2 && v.action === x);
ok('bot: Buy vault bought 6 USDT0 (3×)', row('bought')?.amount === '6000000' && row('bought')?.multiplier === 3, JSON.stringify(r.vaults));

/* ---- Create a Take Profit vault (ladder, reference 70 → OKB ~12% above → 1×) ---- */
await go('#/create?sell', 600);
await page.click('[data-a=cmode][data-v="3"]'); await page.click('[data-a=cnext]'); await page.waitForTimeout(200);
await page.fill('#c-ref', '70'); await page.fill('#c-limit', '72');
await page.reload(); await page.waitForTimeout(2500); // phone browsers often reload the tab after visiting the wallet app
ok('create: typed values survive a page reload', (await page.inputValue('#c-ref')) === '70' && (await page.inputValue('#c-limit')) === '72', await page.inputValue('#c-ref'));
await page.click('[data-a=cnext]'); await page.waitForTimeout(300);
ok('take profit review: ladder sentence', /Latch sells at most once a day, only on a move: 0\.02 OKB when OKB is 5% or more above 70\.00/.test(await txt()), (await txt()).split('\n').find((l) => /Latch sells/.test(l)));
{ // a wallet with no OKB is told before it tries to sign (found in a fresh-wallet phone test)
  const node = async (method, params) => (await (await fetch(cfg.rpc[0], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
  const okbBal = await node('eth_getBalance', [cfg.user, 'latest']);
  ok('review: no "no OKB" warning while the wallet has OKB', !/Your wallet has no OKB on X Layer/.test(await txt()));
  await node('anvil_setBalance', [cfg.user, '0x0']); await page.reload(); await page.waitForTimeout(3000);
  ok('review: a wallet with 0 OKB is warned it needs a tiny OKB network fee first', /Your wallet has no OKB on X Layer\. Every transaction needs a tiny network fee in OKB/.test(await txt()), (await txt()).slice(0, 400));
  await node('anvil_setBalance', [cfg.user, okbBal]); await page.reload(); await page.waitForTimeout(3000);
  ok('review: warning gone once the wallet has OKB again', !/Your wallet has no OKB/.test(await txt()) && /Create my vault/.test(await txt()));
}
await page.click('[data-a=ccreate]'); await page.waitForTimeout(2500);
await page.evaluate(() => { // pretend the page reloaded before it saw the approval: back on Review, vault count from before
  const d = JSON.parse(localStorage.getItem('latch.create.v2')); d.c.step = 3; d.c.before = 1; d.c.by = d.c.by || null; d.c.created = undefined;
  localStorage.setItem('latch.create.v2', JSON.stringify(d));
});
await page.reload(); await page.waitForTimeout(4000);
ok('create: after a reload mid-approval, finds the new vault and shows Add funds', /Your vault is live/.test(await txt()), (await txt()).slice(0, 300));
await page.fill('#c-deposit', '0.1'); await page.click('[data-a=cdeposit]'); await page.waitForFunction(() => location.hash === '#/vaults', null, { timeout: 20000 }).catch(() => {}); await page.waitForTimeout(1500);
r = await runOnce(botEnv, { send: true, wait: true, prices: P(78.5) });
ok('bot: Take Profit vault sold 0.02 OKB (ladder 1×)', r.vaults.some((v) => v.version === 2 && v.kind === 'take-profit' && v.action === 'sold' && v.amount === '20000000000000000'), JSON.stringify(r.vaults));

/* ---- My vaults after trades ---- */
await page.click('main [data-a=refresh]'); await page.waitForTimeout(6000);
const mv = await txt();
ok('My vaults: Buy vault shows OKB bought and 1 trade', /Buy OKB · Smart[\s\S]*OKB bought\s*\n?\s*0\.0[0-9]+/.test(mv), mv.slice(0, 500));
ok('My vaults: Take profit card present', /Take profit · Ladder/.test(mv));
ok('My vaults: classic vaults not shown when none', !/Classic vaults/.test(mv));
await page.click('.vault[data-ver="2"] >> nth=0 >> summary >> nth=1'); await page.waitForTimeout(1500);
ok('recent trades table shows 3×', /3×/.test(await page.evaluate(() => document.querySelector('.vault[data-ver="2"] .hist')?.innerText || '')));
await page.screenshot({ path: shots + '/5-vaults.png', fullPage: true });
// change strategy on the Take Profit vault → Steady
await page.click('.vault[data-ver="2"] >> nth=1 >> [data-a=vstrategy]'); await page.waitForTimeout(300);
await page.selectOption('#dg-mode', '0'); await page.click('.sheet [type=submit]'); await page.waitForTimeout(3000);
ok('strategy changed to Steady', /Take profit · Steady/.test(await txt()), (await txt()).slice(0, 400));
// pause the Buy vault, then withdraw all
await page.click('.vault[data-ver="2"] >> nth=0 >> [data-a=vpause]'); await page.waitForTimeout(3000);
ok('Buy vault paused', /Paused/.test(await page.evaluate(() => document.querySelector('.vault[data-ver="2"] .status').innerText)));
await page.click('.vault[data-ver="2"] >> nth=0 >> [data-a=vwithdraw]'); await page.waitForTimeout(300);
await page.click('.sheet [type=submit]'); await page.waitForTimeout(3500);
ok('withdraw all → USDT0 left 0.00', /USDT0 left\s*\n?\s*0\.00/.test(await txt()), (await txt()).slice(0, 400));
await page.evaluate(() => { window.__freeGasDown = true; });
await page.click('.vault[data-ver="2"] >> nth=0 >> [data-a=vadd]'); await page.waitForTimeout(300);
ok('Add funds box explains both ways, with the full vault address to copy', /Two ways to add money/.test(await page.locator('.sheet').innerText()) && /0x[0-9a-fA-F]{40}/.test(await page.locator('.sheet').innerText()));
await page.screenshot({ path: shots + '/5a-add-howto.png' });
await page.fill('#dg-amt', '1.5'); await page.click('.sheet [type=submit]'); await page.waitForTimeout(5000);
ok('wallet refuses plain token transfers (like OKX on X Layer): Add USDT0 still works through the deposit helper (approve once + deposit) → USDT0 left 1.50', /USDT0 left\s*\n?\s*1\.50/.test(await txt()), (await txt()).slice(0, 400));

/* ---- The chip, Activity, Safety ---- */
await go('#/chip', 800);
ok('chip page: table of every answer', /Everything the chip can answer/.test(await txt()) && (await page.locator('table.grid').count()) === 2);
await page.click('[data-a=xs][data-bit="0"]'); await page.waitForTimeout(200);
ok('chip page: paused safety bit → Wait', /^Wait/.test(await verdict()) && /safety check failed/i.test(await verdict()));
await page.screenshot({ path: shots + '/6-chip.png', fullPage: true });
await go('#/activity', 6000);
const act = await txt();
ok('activity: totals + trades with chip sizes', /Trades checked by chip\s*\n?\s*2/.test(act) && /chip 3×/.test(act) && /chip 1×/.test(act), act.slice(0, 600));
await page.screenshot({ path: shots + '/7-activity.png', fullPage: true });
/* ---- Demo mode: whole journey with play money ---- */
await go('#/demo', 3000);
ok('demo: banner says play money, nothing on chain', /Play money, no wallet, nothing is sent on chain/.test(await txt()));
await page.click('[data-a=dmReset]'); await page.waitForTimeout(400);
await page.click('[data-a=dmCreate]'); await page.waitForTimeout(400);
ok('demo: vault created with 20 USDT0 from the play wallet (100 → 80)', /Demo vault 1 · Buy OKB · Smart/.test(await txt()) && /80\.00 USDT0/.test(await txt()), (await txt()).slice(0, 600));
await page.evaluate(() => { const r = document.querySelector('[data-a=dmShift]'); r.value = '-25'; r.dispatchEvent(new Event('input', { bubbles: true })); });
await page.click('[data-a=dm][data-k=mood][data-v="1"]'); await page.waitForTimeout(300);
ok('demo: OKB 25% under the reference, calm market → the chip says Buy 3×', /Buy 3× · 6\.00 USDT0/.test(await txt()), (await txt()).slice(0, 900));
await page.click('[data-a=dmRun]'); await page.waitForTimeout(400);
let dt = await txt();
ok('demo: the agent bought (log shows chip 3×), vault 20 → 14 USDT0, used today 6 of 12', /Bought/.test(dt) && /chip 3×/.test(dt) && /14\.00/.test(dt) && /6\.00 of 12\.00/.test(dt), dt.slice(0, 1200));
await page.screenshot({ path: shots + '/8-demo.png', fullPage: true });
await page.click('[data-a=dmPause]'); await page.waitForTimeout(200); await page.click('[data-a=dmRun]'); await page.waitForTimeout(300);
ok('demo: paused vault does not trade', (await page.locator('.feed li').count()) === 1 && /Paused by you/.test(await txt()));
await page.click('[data-a=dmWithdraw]'); await page.waitForTimeout(300);
ok('demo: Withdraw all returns 14 USDT0 to the play wallet (80 → 94)', /94\.00 USDT0/.test(await txt()), (await txt()).slice(0, 500));
await page.click('[data-a=dm][data-k=mood][data-v="4"]'); await page.click('[data-a=dmPause]'); await page.click('[data-a=dmAdd]'); await page.waitForTimeout(300);
ok('demo: very jumpy market → Smart waits, and says why', /very jumpy, so this strategy waits/.test(await txt()), (await txt()).slice(0, 900));
await go('#/agents', 500);
ok('agents page: Latch agent + AI agents with the Agentic Wallet, install command, live vault', /Latch's agent runs your vault/.test(await txt()) && /npx skills add sollid-web\/latch/.test(await txt()) && /OKX Agentic Wallet/.test(await txt()));
await page.screenshot({ path: shots + '/7b-agents.png', fullPage: true });
await go('#/safety', 500);
ok('safety page', /What a stolen agent key could do/.test(await txt()) && /Questions/.test(await txt()));
ok('no page errors', errs.length === 0, errs.join(' | '));

/* ---- Phone layout ---- */
await page.setViewportSize({ width: 390, height: 844 });
for (const [h, n] of [['#/', 'm-home'], ['#/create?buy', 'm-create'], ['#/vaults', 'm-vaults'], ['#/chip', 'm-chip']]) {
  await go(h, h === '#/vaults' ? 4000 : 800);
  await page.screenshot({ path: `${shots}/${n}.png`, fullPage: true });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(`phone ${h}: no sideways scrolling`, over <= 1, over);
}
await b.close();
console.log(process.exitCode ? '\nSOME FAILED' : '\nALL PASS');
