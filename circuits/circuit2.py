"""Latch v2 strategy circuit #2: NAND netlist + exhaustive check against a plain-Python spec.

Inputs (16 bits, bit index in the input word):
  0-6   s0..s6  safety bits; must equal 0x7e (same as circuit #1)
  7-9   d0..d2  dip depth: 0 above ref, 1 ~2.5%, 2 5%, 3 10%, 4 15%, 5 20%, 6 30%, 7 deeper
  10-11 v0..v1  volatility: 0 calm, 1 mild, 2 jumpy, 3 very jumpy  (v1=1 means jumpy)
  12-13 m0..m1  mode: 0 plain DCA, 1 dip-only, 2 smart DCA, 3 ladder
  14-15 r0..r1  reserved, must be 0 (blocks garbage/future encodings)
Outputs: allow, k1, k0  (multiplier k = 0..3 x base amount; k=0 whenever allow=0)
"""
import itertools, json

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
    if m == 3:                      # ladder: steps at 5%, 15%, 30%
        if d >= 6: return (1, 3)
        if d >= 4: return (1, 2)
        if d >= 2: return (1, 1)
        return (0, 0)
    # smart DCA: 1x, 2x at 10%+, 3x at 20%+, back to 1x when jumpy
    if jumpy: k = 1
    elif d >= 5: k = 3
    elif d >= 3: k = 2
    else: k = 1
    return (1, k)

# ---------- NAND netlist builder ----------
gates = []          # each gate: (a, b) wire ids; wire ids 0..15 are inputs, 16+ are gates
def nand(a, b):
    gates.append((a, b)); return 15 + len(gates)
def NOT(a):    return nand(a, a)
def AND(a, b): return NOT(nand(a, b))
def OR(a, b):  return nand(NOT(a), NOT(b))
def OR_n(na, nb): return nand(na, nb)          # OR from already-inverted inputs

s = list(range(7)); d0, d1, d2 = 7, 8, 9; v0, v1 = 10, 11; m0, m1 = 12, 13; r0, r1 = 14, 15

# safe = s1..s6 all 1, s0 = 0, r0 = r1 = 0
t = AND(s[1], s[2]); t = AND(t, s[3]); t = AND(t, s[4]); t = AND(t, s[5]); t = AND(t, s[6])
nz = nand(NOT(s[0]), nand(NOT(r0), NOT(r1)))    # = s0 | r0 | r1 ... built below properly
# (rewrite cleanly: zeros_ok = !s0 & !r0 & !r1)
gates.pop()  # discard the line above
ns0, nr0, nr1 = NOT(s[0]), NOT(r0), NOT(r1)
zeros_ok = AND(AND(ns0, nr0), nr1)
safe = AND(t, zeros_ok)

# depth flags
nd0, nd1, nd2 = NOT(d0), NOT(d1), NOT(d2)
a  = nand(nand(nd0, nd1), nd2)          # d >= 1
a  = NOT(AND(AND(nd0, nd1), nd2))
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
l_hi  = AND(ladder, d2)
l_3   = AND(ladder, e6)
hi    = OR(s_hi, l_hi)
three = OR(s_3, l_3)
k1 = AND(allow, hi)
k0 = AND(allow, OR(NOT(hi), three))

OUT = {"allow": allow, "k1": k1, "k0": k0}

def run(x):
    w = [(x >> i) & 1 for i in range(16)]
    for ga, gb in gates:
        w.append(1 - (w[ga] & w[gb]))
    return w

# ---------- exhaustive check ----------
bad = 0
for x in range(1 << 16):
    w = run(x)
    got = (w[allow], w[k1] * 2 + w[k0])
    if got != spec(x):
        bad += 1
        if bad < 5: print("MISMATCH", hex(x), got, spec(x))
print(f"gates: {len(gates)} NAND, checked {1<<16} inputs, mismatches: {bad}")

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

json.dump({"inputs": 16, "gates": gates, "outputs": OUT}, open("/home/claude/circuit2.json", "w"))
