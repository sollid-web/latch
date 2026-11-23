#!/usr/bin/env bash
# FREE rehearsal of the DeWEB publish on a local copy (fork) of X Layer mainnet. Nothing is sent to mainnet.
#   ./scripts/preflight-deweb.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
PORT="${FORK_PORT:-8549}"
ONCHAIN=1 node scripts/build-web.mjs
echo "Starting a local copy of X Layer mainnet…"
anvil --fork-url "${RPC:-https://rpc.xlayer.tech}" --port "$PORT" --silent &
ANVIL=$!; trap 'kill $ANVIL 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do cast chain-id --rpc-url "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break; sleep 1; done
if [ -f keeper/.env ]; then set -a; . ./keeper/.env; set +a; fi
OWNER=$(cast wallet address --private-key "$OWNER_PRIVATE_KEY")
cast rpc anvil_setBalance "$OWNER" 0x56BC75E2D63100000 --rpc-url "http://127.0.0.1:$PORT" >/dev/null   # 100 OKB on the copy only
echo "== Real costs (read from mainnet, nothing sent)"
node scripts/publish-deweb.mjs || true
echo "== Publishing on the copy"
RPC_URL="http://127.0.0.1:$PORT" SEND=1 node scripts/publish-deweb.mjs
echo
echo "REHEARSAL OK: stored, named and read back on the copy. Nothing was sent to mainnet."
