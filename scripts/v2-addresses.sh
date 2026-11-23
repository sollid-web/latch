# Canonical X Layer addresses and settings for Latch v2 (sourced by preflight-v2.sh and golive-v2.sh).
PROCESSOR=0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813      # Latch's TapeOut processor (circuit #1 lives here too)
BEM=0x60e62Efa9405d6873C5deaBD4E6CC91c25363952            # TapeOut fee token (8 decimals)
USDT=0x779Ded0c9e1022225f8E0630b35a9b54bE713736           # USDT0 (6 decimals)
WOKB=0xe538905cf8410324e03A5A23C1c177a474D59b2b           # wrapped OKB (18 decimals)
ROUTER=0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca         # Uniswap SwapRouter02
UNI_FACTORY=0x4B2ab38DBF28D31D467aA8993f6c2585981D6804
POOL_EXPECTED=0xe3be6a0137f1b0602fc1a4841686f43b340a5082   # USDT0/WOKB 0.05%
POOL_FEE=500
TREASURY="${TREASURY:-0xb4bDEAc86CBdd0C148BB98504e1c35d8451A23a4}"
TWAP=1800                 # 30-minute average price
SLIPPAGE_BPS=100          # 1%
MIN_BUY=1000000           # 1 USDT0 smallest Buy trade
MIN_SELL=10000000000000000  # 0.01 OKB smallest Take Profit trade
