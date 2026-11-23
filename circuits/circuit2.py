"""Latch v2 strategy circuit #2: NAND netlist + exhaustive check against a plain-Python spec.

Inputs (16 bits, bit index in the input word):
  0-6   s0..s6  safety bits; must equal 0x7e (same as circuit #1)
  7-9   d0..d2  dip depth: 0 above ref, 1 ~2.5%, 2 5%, 3 10%, 4 15%, 5 20%, 6 30%, 7 deeper
  10-11 v0..v1  volatility: 0 calm, 1 mild, 2 jumpy, 3 very jumpy  (v1=1 means jumpy)
  12-13 m0..m1  mode: 0 plain DCA, 1 dip-only, 2 smart DCA, 3 ladder
  14-15 r0..r1  reserved, must be 0 (blocks garbage/future encodings)
Outputs: allow, k1, k0  (multiplier k = 0..3 x base amount; k=0 whenever allow=0)
"""
import itertools, json, os

def spec(x):
    bit = lambda i: (x >> i) & 1
    safety = x & 0x7f
    d = (x >> 7) & 7
    v = (x >> 10) & 3
    m = (x >> 12) & 3
    r = (x >> 14) & 3
    if safety != 0x7e or r != 0:
        return (0, 0)
    jumpy = v >= 2
    if m == 0:                      # plain DCA: always 1x
        return (1, 1)
    if m == 1:                      # dip-only: 1x only below reference
        return (1, 1) if d >= 1 else (0, 0)
    if v == 3:                      # very jumpy: smart/ladder pause
        return (0, 0)
    if m == 3:                      # ladder: steps at 5%, 15%, 30%; back to 1x when jumpy
        if d < 2: return (0, 0)
        if jumpy: return (1, 1)
        if d >= 6: return (1, 3)
        if d >= 4: return (1, 2)
        return (1, 1)
    # smart DCA: 1x, 2x at 10%+, 3x at 20%+, back to 1x when jumpy
    if jumpy: k = 1
    elif d >= 5: k = 3
    elif d >= 3: k = 2
    else: k = 1
    return (1, k)

# ---------- NAND netlist builder ----------
gates = []          # each gate: (a, b) wire ids; wire ids 0..15 are inputs, 16+ are gates
_seen = {}          # structural hashing: the same NAND of the same two wires is built only once
def nand(a, b):
    key = (min(a, b), max(a, b))
    if key not in _seen:
        gates.append((a, b)); _seen[key] = 15 + len(gates)
    return _seen[key]
def NOT(a):    return nand(a, a)
def AND(a, b): return NOT(nand(a, b))
def OR(a, b):  return nand(NOT(a), NOT(b))
def OR_n(na, nb): return nand(na, nb)          # OR from already-inverted inputs

s = list(range(7)); d0, d1, d2 = 7, 8, 9; v0, v1 = 10, 11; m0, m1 = 12, 13; r0, r1 = 14, 15

# safe = s1..s6 all 1, s0 = 0, r0 = r1 = 0
t = AND(s[1], s[2]); t = AND(t, s[3]); t = AND(t, s[4]); t = AND(t, s[5]); t = AND(t, s[6])
ns0, nr0, nr1 = NOT(s[0]), NOT(r0), NOT(r1)
zeros_ok = AND(AND(ns0, nr0), nr1)
safe = AND(t, zeros_ok)

# depth flags
nd0, nd1, nd2 = NOT(d0), NOT(d1), NOT(d2)
a  = NOT(AND(AND(nd0, nd1), nd2))       # d >= 1
d2p = OR(d2, d1)                        # d >= 2
b  = OR(d2, AND(d1, d0))                # d >= 3
c  = AND(d2, OR(d1, d0))                # d >= 5
e6 = AND(d2, d1)                        # d >= 6
nv1 = NOT(v1)
vhot = AND(v1, v0)                      # very jumpy

smart = AND(m1, NOT(m0)); ladder = AND(m1, m0); dipo = AND(NOT(m1), m0); plain = AND(NOT(m1), NOT(m0))
ok_plain = plain
ok_dip   = AND(dipo, a)
ok_smart = AND(smart, NOT(vhot))
ok_lad   = AND(AND(ladder, NOT(vhot)), d2p)
allow = AND(safe, OR(OR(ok_plain, ok_dip), OR(ok_smart, ok_lad)))

# smart: calm -> 2x at b, 3x at c.   ladder: 2x at d>=4 (=d2), 3x at e6
s_hi  = AND(AND(smart, nv1), b)         # smart >= 2x
s_3   = AND(AND(smart, nv1), c)
l_hi  = AND(AND(ladder, nv1), d2)
l_3   = AND(AND(ladder, nv1), e6)
hi    = OR(s_hi, l_hi)
three = OR(s_3, l_3)
k1 = AND(allow, hi)
k0 = AND(allow, OR(NOT(hi), three))

OUT = {"allow": allow, "k1": k1, "k0": k0}

# ---------- drop gates whose output is never used, renumber the rest ----------
live, stack = set(), list(OUT.values())
while stack:
    w = stack.pop()
    if w >= 16 and w not in live:
        live.add(w); stack.extend(gates[w - 16])
new_id, kept = {i: i for i in range(16)}, []
for i, g in enumerate(gates):
    if i + 16 in live:
        kept.append((new_id[g[0]], new_id[g[1]])); new_id[i + 16] = 15 + len(kept)
gates = kept
allow, k1, k0 = new_id[allow], new_id[k1], new_id[k0]
OUT = {"allow": allow, "k1": k1, "k0": k0}

def run(x):
    w = [(x >> i) & 1 for i in range(16)]
    for ga, gb in gates:
        w.append(1 - (w[ga] & w[gb]))
    return w

# ---------- TAP-02 export (what the TapeOut processor runs) ----------
# Signals: 0 = constant 0, 1 = constant 1, inputs at 2..17 (input bit i -> signal i+2), gate g -> signal 18+g.
# Outputs are the LAST 3 signals, packed LSB-first: bit0 = allow, bit1 = k0, bit2 = k1  (k = (out >> 1) & 3).
tap = [(a + 2, b + 2) for a, b in gates]
def buf(w):                        # copy a wire to the end with two NANDs (NOT NOT)
    tap.append((w + 2, w + 2)); n = 17 + len(tap)
    tap.append((n, n))
for w in (allow, k0, k1):
    buf(w)
# The buffers above are interleaved (NOT x, NOT NOT x) — make sure the very last three signals are the outputs:
outs = []
tap2 = list(tap[:len(gates)])
nots = []
for w in (allow, k0, k1):
    tap2.append((w + 2, w + 2)); nots.append(17 + len(tap2))
for n in nots:
    tap2.append((n, n))
tap = tap2

def run_tap(x):
    sig = [0, 1] + [(x >> i) & 1 for i in range(16)]
    for a, b in tap:
        sig.append(1 - (sig[a] & sig[b]))
    o = sig[-3:]
    return o[0] | (o[1] << 1) | (o[2] << 2)

# ---------- exhaustive check ----------
bad = 0
for x in range(1 << 16):
    w = run(x)
    got = (w[allow], w[k1] * 2 + w[k0])
    if got != spec(x):
        bad += 1
        if bad < 5: print("MISMATCH", hex(x), got, spec(x))
print(f"gates: {len(gates)} NAND, checked {1<<16} inputs, mismatches: {bad}")
bad2 = 0
for x in range(1 << 16):
    al, k = spec(x)
    if run_tap(x) != (al | ((k & 1) << 1) | ((k >> 1) << 2)):
        bad2 += 1
print(f"TAP-02 netlist: {len(tap)} NAND (incl. 6 output buffers), checked {1<<16} inputs, mismatches: {bad2}")
assert bad == 0 and bad2 == 0
netlist = '0x' + ''.join('00' + format(a, '06x') + format(b, '06x') for a, b in tap)

# readable truth summary for the valid safety pattern, calm market
names = ["plain DCA", "dip-only", "smart DCA", "ladder"]
deps = ["above", "2.5%", "5%", "10%", "15%", "20%", "30%", "deeper"]
for vol in (0, 2, 3):
    print("\nvolatility", ["calm","","jumpy","very jumpy"][vol])
    print(f"{'mode':10}" + "".join(f"{x:>7}" for x in deps))
    for m in range(4):
        row = []
        for dd in range(8):
            al, k = spec(0x7e | dd << 7 | vol << 10 | m << 12)
            row.append(f"{k}x" if al else "-")
        print(f"{names[m]:10}" + "".join(f"{x:>7}" for x in row))

out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "circuit2.json")
json.dump({"inputs": 16, "outputs": 3, "outputOrder": ["allow", "k0", "k1"], "gates": len(tap), "tap02": tap, "netlist": netlist}, open(out_path, "w"))
print("wrote", out_path)
