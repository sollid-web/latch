/**
 * Latch daemon — production-ready skeleton for X Layer (chain 196).
 *
 * The keeper key pays gas only. Funds never leave the TapeOut container
 * without the circuit returning allow. Restart-safe: daily caps live on-chain.
 *
 * Required env vars:
 *   LATCH_RPC          RPC endpoint (default: https://rpc.xlayer.tech)
 *   LATCH_RELAY        Deployed LatchRelay contract address
 *   LATCH_KEEPER_KEY   Private key (0x-prefixed). Gas only — no withdrawal power.
 *
 * Optional env vars:
 *   LATCH_THRESHOLD    OKB/USDT price at-or-below which tick fires (default: 48)
 *   LATCH_SWEEP_WEI    Sweep amount in token base units (default: 50 * 1e18)
 *   LATCH_ORACLE_URL   HTTP endpoint returning { "price": <number> } for OKB/USDT
 *                      Defaults to the OKX public ticker API.
 *   LATCH_POLL_MS      Oracle poll interval in ms (default: 10000)
 *   LATCH_GAS_LIMIT    Gas limit per tick tx (default: 300000)
 *
 * Usage:
 *   LATCH_RPC=https://rpc.xlayer.tech \
 *   LATCH_RELAY=0xYourRelay \
 *   LATCH_KEEPER_KEY=0x… \
 *   LATCH_THRESHOLD=48 \
 *   node daemon/latch-daemon.mjs
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC         = process.env.LATCH_RPC ?? "https://rpc.xlayer.tech";
const RELAY       = process.env.LATCH_RELAY;
const KEEPER_KEY  = process.env.LATCH_KEEPER_KEY;
const THRESHOLD   = Number(process.env.LATCH_THRESHOLD ?? "48");
const SWEEP_WEI   = BigInt(process.env.LATCH_SWEEP_WEI ?? String(50n * 10n ** 18n));
const ORACLE_URL  = process.env.LATCH_ORACLE_URL ?? "https://www.okx.com/api/v5/market/ticker?instId=OKB-USDT";
const POLL_MS     = Number(process.env.LATCH_POLL_MS ?? "10000");
const GAS_LIMIT   = Number(process.env.LATCH_GAS_LIMIT ?? "300000");

if (!RELAY || !KEEPER_KEY) {
  console.log("Latch daemon idle. Required env vars not set.");
  console.log("  LATCH_RELAY      — deployed LatchRelay address");
  console.log("  LATCH_KEEPER_KEY — gas-only keeper private key");
  console.log(`Would poll ${RPC} and call tick(${SWEEP_WEI}) when OKB <= ${THRESHOLD}.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Minimal JSON-RPC client (no dependencies)
// ---------------------------------------------------------------------------

let rpcId = 1;

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message} (${json.error.code})`);
  return json.result;
}

// ---------------------------------------------------------------------------
// Minimal secp256k1 / RLP signing (pure Node — no ethers/viem)
// Uses Node's built-in `crypto` module (available from Node 15+).
// ---------------------------------------------------------------------------

import { createHash, createHmac } from "crypto";

async function keccak256(data) {
  // Try ethereum-cryptography first (npm i ethereum-cryptography)
  try {
    const mod = await import("ethereum-cryptography/keccak.js");
    if (mod?.keccak256) return Buffer.from(mod.keccak256(data));
  } catch {}
  // Fallback: the `keccak` native addon (npm i keccak)
  try {
    const mod = await import("keccak");
    return mod.default("keccak256").update(data).digest();
  } catch {}
  throw new Error(
    "No keccak implementation found.\n" +
    "Run in the repo root:  npm install ethereum-cryptography\n" +
    "or in daemon/:         npm install keccak",
  );
}

// RLP encode a list of Buffer items (simplified — enough for legacy tx).
function rlpEncodeLength(length, offset) {
  if (length < 56) return Buffer.from([length + offset]);
  const hex = length.toString(16);
  const lenBytes = Buffer.from(hex.padStart(hex.length + (hex.length % 2), "0"), "hex");
  return Buffer.concat([Buffer.from([lenBytes.length + offset + 55]), lenBytes]);
}

function rlpEncode(input) {
  if (Buffer.isBuffer(input)) {
    if (input.length === 1 && input[0] < 0x80) return input;
    return Buffer.concat([rlpEncodeLength(input.length, 0x80), input]);
  }
  const body = Buffer.concat(input.map(rlpEncode));
  return Buffer.concat([rlpEncodeLength(body.length, 0xc0), body]);
}

function hexToBuffer(hex) {
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

function bufferToHex(buf) {
  return "0x" + buf.toString("hex");
}

function bigintToBuffer(value) {
  if (value === 0n) return Buffer.alloc(0);
  const hex = value.toString(16);
  return Buffer.from(hex.padStart(hex.length + (hex.length % 2), "0"), "hex");
}

// secp256k1 sign — pure JS (RFC 6979 deterministic k)
// Sufficient for keeper gas payments; for high-value production use a HSM.
const P  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

function modp(n) { return ((n % P) + P) % P; }
function modn(n) { return ((n % N) + N) % N; }
function modInv(a, m) {
  let [old_r, r] = [a, m], [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return modn(old_s);
}
function pointAdd(P1, P2) {
  if (!P1) return P2; if (!P2) return P1;
  const [x1, y1] = P1, [x2, y2] = P2;
  if (x1 === x2) {
    if (y1 !== y2) return null;
    const lam = modp(3n * x1 * x1 * modInv(2n * y1, P));
    const x3 = modp(lam * lam - 2n * x1);
    return [x3, modp(lam * (x1 - x3) - y1)];
  }
  const lam = modp((y2 - y1) * modInv(x2 - x1, P));
  const x3 = modp(lam * lam - x1 - x2);
  return [x3, modp(lam * (x1 - x3) - y1)];
}
function pointMul(k, point) {
  let result = null, addend = point;
  while (k > 0n) {
    if (k & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    k >>= 1n;
  }
  return result;
}

function hmacSha256(key, ...msgs) {
  const h = createHmac("sha256", key);
  for (const m of msgs) h.update(m);
  return h.digest();
}

function rfc6979k(privateKeyBytes, msgHash) {
  const x = privateKeyBytes, h1 = msgHash;
  let V = Buffer.alloc(32, 0x01);
  let K = Buffer.alloc(32, 0x00);
  K = hmacSha256(K, V, Buffer.from([0x00]), x, h1);
  V = hmacSha256(K, V);
  K = hmacSha256(K, V, Buffer.from([0x01]), x, h1);
  V = hmacSha256(K, V);
  while (true) {
    V = hmacSha256(K, V);
    const k = BigInt("0x" + V.toString("hex"));
    if (k >= 1n && k < N) return k;
    K = hmacSha256(K, V, Buffer.from([0x00]));
    V = hmacSha256(K, V);
  }
}

function ecSign(privateKey, msgHash) {
  const pkBuf = hexToBuffer(privateKey);
  const hashBuf = Buffer.isBuffer(msgHash) ? msgHash : hexToBuffer(msgHash);
  const z = BigInt("0x" + hashBuf.toString("hex"));
  const d = BigInt("0x" + pkBuf.toString("hex"));
  const k = rfc6979k(pkBuf, hashBuf);
  const [rx] = pointMul(k, [Gx, Gy]);
  const r = modn(rx);
  const s = modn(modInv(k, N) * (z + r * d));
  const sBuf = Buffer.from(s.toString(16).padStart(64, "0"), "hex");
  const [, Ry] = pointMul(k, [Gx, Gy]);
  const v = (Ry % 2n === 0n) ? 0n : 1n;
  return { r, s, v };
}

async function getPublicAddress(privateKey) {
  const pk = hexToBuffer(privateKey);
  const d = BigInt("0x" + pk.toString("hex"));
  const [pubX, pubY] = pointMul(d, [Gx, Gy]);
  const pubBytes = Buffer.concat([
    Buffer.from("04", "hex"),
    Buffer.from(pubX.toString(16).padStart(64, "0"), "hex"),
    Buffer.from(pubY.toString(16).padStart(64, "0"), "hex"),
  ]);
  const hash = await keccak256(pubBytes.subarray(1));
  return "0x" + Buffer.from(hash).subarray(12).toString("hex");
}

// ---------------------------------------------------------------------------
// ABI helpers — encode tick(uint256) and decode preview return
// ---------------------------------------------------------------------------

// selector = keccak256("tick(uint256)")[0..4]
// We hardcode it: 0x0a1b4516  (verify: keccak256(Buffer.from("tick(uint256)")))
// Actually compute it at start-up to avoid typos.

async function selector(sig) {
  const h = await keccak256(Buffer.from(sig));
  return Buffer.from(h).subarray(0, 4);
}

function encodeUint256(value) {
  return Buffer.from(value.toString(16).padStart(64, "0"), "hex");
}

// preview(uint256) returns (uint8 bits, bool allow)
// We only need the `allow` bool (second 32-byte word, last byte).
function decodePreview(hex) {
  const data = hexToBuffer(hex);
  // bits at offset 0, allow at offset 32
  const allow = data[63] === 1;
  const bits = data[31];
  return { bits, allow };
}

// ---------------------------------------------------------------------------
// Oracle — fetch OKB/USDT price
// ---------------------------------------------------------------------------

async function fetchPrice() {
  const res = await fetch(ORACLE_URL, { signal: AbortSignal.timeout(5000) });
  const json = await res.json();

  // OKX API: { data: [{ last: "56.12", … }] }
  if (json?.data?.[0]?.last !== undefined) {
    return Number(json.data[0].last);
  }
  // Generic: { price: 56.12 }
  if (json?.price !== undefined) {
    return Number(json.price);
  }
  throw new Error(`Unrecognised oracle response: ${JSON.stringify(json).slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Transaction builder — legacy type-0 (X Layer mainnet supports EIP-1559 but
// legacy txs work fine and require no base-fee polling).
// ---------------------------------------------------------------------------

async function buildAndSignTick(from, nonce, gasPrice, calldata) {
  const chainId = 196n;
  // EIP-155 legacy fields for signing: [nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]
  const fields = [
    bigintToBuffer(BigInt(nonce)),
    bigintToBuffer(gasPrice),
    bigintToBuffer(BigInt(GAS_LIMIT)),
    hexToBuffer(RELAY),
    Buffer.alloc(0),       // value = 0
    calldata,
    bigintToBuffer(chainId),
    Buffer.alloc(0),
    Buffer.alloc(0),
  ];
  const encoded = rlpEncode(fields);
  const hash = await keccak256(encoded);
  const { r, s, v: vRaw } = ecSign(KEEPER_KEY, Buffer.from(hash));

  // EIP-155 v = chainId * 2 + 35 + vRaw
  const v = chainId * 2n + 35n + vRaw;
  const signedFields = [
    bigintToBuffer(BigInt(nonce)),
    bigintToBuffer(gasPrice),
    bigintToBuffer(BigInt(GAS_LIMIT)),
    hexToBuffer(RELAY),
    Buffer.alloc(0),
    calldata,
    bigintToBuffer(v),
    Buffer.from(r.toString(16).padStart(64, "0"), "hex"),
    Buffer.from(s.toString(16).padStart(64, "0"), "hex"),
  ];
  return bufferToHex(rlpEncode(signedFields));
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  // Pre-compute selectors
  const tickSel    = await selector("tick(uint256)");
  const previewSel = await selector("preview(uint256)");
  const sweepData  = Buffer.concat([tickSel, encodeUint256(SWEEP_WEI)]);
  const previewData = Buffer.concat([previewSel, encodeUint256(SWEEP_WEI)]);

  const from = await getPublicAddress(KEEPER_KEY);

  console.log(JSON.stringify({
    ok: true,
    chainId: 196,
    rpc: RPC,
    relay: RELAY,
    keeper: from,
    threshold: THRESHOLD,
    sweepWei: SWEEP_WEI.toString(),
    pollMs: POLL_MS,
    gasLimit: GAS_LIMIT,
  }));

  // Track last tick to avoid double-firing on the same price point.
  let lastTickAt = 0;
  const MIN_TICK_INTERVAL = 60_000; // at most once per minute

  while (true) {
    try {
      const price = await fetchPrice();
      const ts = new Date().toISOString();

      if (price > THRESHOLD) {
        console.log(`[${ts}] OKB ${price.toFixed(2)} > ${THRESHOLD} — holding`);
      } else {
        console.log(`[${ts}] OKB ${price.toFixed(2)} <= ${THRESHOLD} — checking circuit…`);

        // eth_call preview (free, no gas)
        const previewHex = await rpc("eth_call", [
          { from, to: RELAY, data: bufferToHex(previewData) },
          "latest",
        ]);

        if (!previewHex || previewHex === "0x") {
          console.warn(`[${ts}] preview returned empty — relay may be paused or not armed`);
        } else {
          const { bits, allow } = decodePreview(previewHex);
          console.log(`[${ts}] preview bits=0b${bits.toString(2).padStart(7, "0")} allow=${allow}`);

          if (!allow) {
            console.log(`[${ts}] circuit denied — skipping tick`);
          } else if (Date.now() - lastTickAt < MIN_TICK_INTERVAL) {
            console.log(`[${ts}] allow but too soon since last tick (${MIN_TICK_INTERVAL / 1000}s cooldown)`);
          } else {
            // Get nonce and gas price
            const [nonceHex, gasPriceHex] = await Promise.all([
              rpc("eth_getTransactionCount", [from, "latest"]),
              rpc("eth_gasPrice", []),
            ]);
            const nonce = parseInt(nonceHex, 16);
            // Add 10% buffer to gas price
            const gasPrice = (BigInt(gasPriceHex) * 11n) / 10n;

            const rawTx = await buildAndSignTick(from, nonce, gasPrice, sweepData);
            const txHash = await rpc("eth_sendRawTransaction", [rawTx]);
            lastTickAt = Date.now();
            console.log(`[${ts}] tick submitted — tx ${txHash}`);

            // Wait a few seconds then check receipt
            await new Promise((r) => setTimeout(r, 6000));
            try {
              const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
              if (receipt) {
                const status = parseInt(receipt.status, 16);
                console.log(`[${ts}] tx ${txHash} — status ${status === 1 ? "SUCCESS" : "REVERTED"} (block ${parseInt(receipt.blockNumber, 16)})`);
              } else {
                console.log(`[${ts}] tx ${txHash} — not yet mined`);
              }
            } catch (receiptErr) {
              console.warn(`[${ts}] could not fetch receipt: ${receiptErr.message}`);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] error: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
