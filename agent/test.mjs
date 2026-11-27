// Local test for the `latch` agent tool (dev only). Needs the local chain from web/e2e-setup.mjs running.
//   node web/e2e-setup.mjs   (terminal 1, wait for READY)      node agent/test.mjs   (terminal 2)
// A stand-in address plays the agent's OKX Agentic Wallet: every transaction the tool prepares is sent exactly
// as printed (to, inputData, amt), the way `onchainos wallet contract-call` would sign and send it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const UI = process.env.UI_DIR || path.join(os.tmpdir(), 'latch-ui');
const web = JSON.parse(fs.readFileSync(path.join(UI, 'web-local.json'), 'utf8'));
const cfgFile = path.join(UI, 'latch-agent.json');
fs.writeFileSync(cfgFile, JSON.stringify({ rpc: web.rpc[0], factory2: web.factory2, processor: web.processor, circuit2Id: web.circuit2Id, usdt: web.usdt, wokb: web.wokb, pool: web.pool, depositor: web.depositor }));
const RPC = web.rpc[0];
const AGENT = '0x00000000000000000000000000000000a9e17001'; // stand-in Agentic Wallet
const SAVE = '0x00000000000000000000000000000000a9e17002';
const rpc = async (method, params) => { const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; };
const latch = (...a) => { try { return JSON.parse(execFileSync('node', [path.join(here, 'latch.mjs'), ...a], { env: { ...process.env, LATCH_CONFIG: cfgFile } }).toString()); } catch (e) { return JSON.parse(e.stdout.toString()); } };
async function sign(t, from = AGENT) { // what `onchainos wallet contract-call --to --input-data --amt` does
  let hash; try { hash = await rpc('eth_sendTransaction', [{ from, to: t.to, data: t.inputData, value: '0x' + BigInt(t.amt).toString(16) }]); } catch { return false; }
  for (let i = 0; i < 50; i++) { const r = await rpc('eth_getTransactionReceipt', [hash]); if (r) return r.status === '0x1'; await new Promise((s) => setTimeout(s, 100)); }
  return false;
}
async function signAll(list) { if (!list?.length) return false; for (const t of list) if (!(await sign(t))) return false; return true; }
let fails = 0;
const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  → ' + JSON.stringify(d).slice(0, 400))); if (!c) fails++; };

await rpc('anvil_setBalance', [AGENT, '0x56BC75E2D63100000']);
await rpc('anvil_setBalance', [SAVE, '0x56BC75E2D63100000']);
// give the agent wallet 50 USDT0 and 1 WOKB from the test user
const erc = (to, amt) => '0xa9059cbb' + to.slice(2).padStart(64, '0') + BigInt(amt).toString(16).padStart(64, '0');
await sign({ to: web.usdt, inputData: erc(AGENT, 50_000_000n), amt: '0' }, web.user);
await sign({ to: web.wokb, inputData: erc(AGENT, 10n ** 18n), amt: '0' }, web.user);

let r = latch('market');
ok('market: 30-minute average and live price', r.okb?.avg30min > 0 && r.okb?.live > 0, r);
const P = r.okb.avg30min;
r = latch('try', '--dir', 'buy', '--mode', 'smart', '--ref', String(+(P * 1.3).toFixed(2)), '--limit', String(Math.ceil(P * 1.2)), '--base', '2');
ok('try: smart buy 20% under the reference → real chip says buy 3× = 6 USDT0', /^buy 3× = 6 USDT0/.test(r.answer), r);
r = latch('try', '--dir', 'sell', '--mode', 'ladder', '--ref', String(P), '--limit', '1');
ok('try: ladder take-profit at the reference → wait', r.answer === 'wait' && /strategy waits/.test(r.why), r);
r = latch('create', '--dir', 'buy', '--mode', 'smart', '--savings', web.factory2, '--base', '2', '--ref', '100', '--limit', '120');
ok('create: refuses output to a contract the factory forbids? (checked on chain at signing)', r.transactions?.length === 1, r);
r = latch('create', '--dir', 'buy', '--mode', 'smart', '--savings', SAVE, '--base', '0.5', '--ref', '100', '--limit', '120');
ok('create: base below the 1 USDT0 minimum refused before signing', /at least 1 USDT0/.test(r.error || ''), r);

// 1. agent creates a Buy vault for its user, Latch's hosted bot trades it
r = latch('create', '--dir', 'buy', '--mode', 'smart', '--savings', SAVE, '--base', '2', '--ref', String(+(P * 1.3).toFixed(2)), '--limit', String(Math.ceil(P * 1.2)));
ok('create: one transaction with an onchainos command', r.transactions?.[0]?.onchainos?.startsWith('onchainos wallet contract-call --to ') && /--chain \d+ --input-data 0x/.test(r.transactions[0].onchainos), r);
ok('create: Agentic Wallet signs it', await sign(r.transactions[0]), r);
r = latch('vaults', '--owner', AGENT);
const v1 = r.vaults?.[0]?.vault;
ok('vaults: the new vault, owned by the agent wallet', v1 && r.vaults[0].job === 'Buy OKB' && /Smart/.test(r.vaults[0].strategy) && r.vaults[0].mostPerTrade === '6 USDT0', r);
r = latch('fund', '--vault', v1, '--amount', '10', '--from', '0x000000000000000000000000000000000000dEaD');
ok('fund: a wallet without enough USDT0 gets a plain answer before signing (not a revert)', /has 0 USDT0 on X Layer, less than the 10 USDT0/.test(r.error || '') && /Send USDT0/.test(r.error || ''), r);
r = latch('fund', '--vault', v1, '--amount', '10');
ok('fund: goes through the deposit helper (approve exactly 10 USDT0, then deposit), never a plain USDT0 transfer OKX wallets refuse',
  r.transactions?.length === 2 && r.transactions[0].to.toLowerCase() === web.usdt.toLowerCase() && r.transactions[0].inputData.startsWith('0x095ea7b3')
  && r.transactions[0].inputData.toLowerCase().includes(web.depositor.slice(2).toLowerCase()) && BigInt('0x' + r.transactions[0].inputData.slice(-64)) === 10_000_000n
  && r.transactions[1].to.toLowerCase() === web.depositor.toLowerCase() && !r.transactions.some((t) => t.inputData.startsWith('0xa9059cbb')), r);
ok('fund: Agentic Wallet signs both, in order', await signAll(r.transactions), r);
r = latch('status', '--vault', v1);
ok('status: what the chip sees and the next trade (3× = 6 USDT0)', r.now?.tradeNow === true && r.now.multiplier === 3 && r.balance === '10 USDT0', r.now);

// 2. the agent wallet as a vault's own bot
r = latch('create', '--dir', 'sell', '--mode', 'smart', '--savings', SAVE, '--base', '0.02', '--ref', String(+(P * 0.88).toFixed(2)), '--limit', String(+(P * 0.9).toFixed(2)), '--keeper', AGENT, '--every', 'any');
ok('create Take Profit vault with the agent as its bot', await sign(r.transactions[0]), r);
const v2 = latch('vaults', '--owner', AGENT).vaults?.[1]?.vault;
r = latch('wrap', '--amount', '0.05');
ok('wrap: OKB → WOKB transaction carries the value', r.transactions?.[0]?.amt === '50000000000000000', r);
r = latch('fund', '--vault', v2, '--amount', '0.1');
ok('fund the Take Profit vault with WOKB (through the helper too)', r.transactions?.at(-1)?.to.toLowerCase() === web.depositor.toLowerCase() && await signAll(r.transactions), r);
const w2 = BigInt(await rpc('eth_call', [{ to: web.wokb, data: '0x70a08231' + v2.slice(2).padStart(64, '0') }, 'latest']));
ok('the WOKB landed in the Take Profit vault', w2 === 10n ** 17n, { w2 });
r = latch('tick', '--vault', v2, '--as', SAVE);
ok('tick: a wallet that is not the vault\'s agent is told plainly', r.tradeNow === false && /only the vault's own agent/.test(r.why), r);
r = latch('tick', '--vault', v2, '--as', AGENT);
ok('tick: chip says sell 2× (OKB ~13.6% above reference)', r.tradeNow === true && r.multiplier === 2 && r.transactions.length === 1, r);
const u0 = BigInt(await rpc('eth_call', [{ to: web.usdt, data: '0x70a08231' + SAVE.slice(2).padStart(64, '0') }, 'latest']));
ok('tick: agent signs, the trade happens', await sign(r.transactions[0]), r);
const u1 = BigInt(await rpc('eth_call', [{ to: web.usdt, data: '0x70a08231' + SAVE.slice(2).padStart(64, '0') }, 'latest']));
ok('the USDT0 went to the owner’s chosen wallet', u1 > u0, { u0, u1 });

// 3. manage
r = latch('strategy', '--vault', v1, '--mode', 'ladder', '--base', '9');
ok('strategy: base above the per-trade limit refused (limits only go down)', /at most the per-trade limit/.test(r.error || ''), r);
r = latch('strategy', '--vault', v1, '--mode', 'ladder');
ok('strategy: switch to ladder', await sign(r.transactions[0]) && /Ladder/.test(latch('status', '--vault', v1).strategy), r);
r = latch('pause', '--vault', v1);
ok('pause', await sign(r.transactions[0]) && latch('status', '--vault', v1).paused === true, r);
r = latch('withdraw', '--vault', v1, '--to', AGENT);
ok('withdraw everything back', r.transactions.length === 1 && await sign(r.transactions[0]) && latch('status', '--vault', v1).balance === '0 USDT0', r);
r = latch('pause', '--vault', v2);
ok('a stranger cannot pause someone else’s vault (refused at signing)', !(await sign(r.transactions[0], SAVE)), r);
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
