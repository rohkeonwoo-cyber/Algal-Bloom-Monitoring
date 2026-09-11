"""심각도 램프를 OKLCH에서 직접 생성 — 명도를 고르게 내리고 색상을 노랑→빨강으로 돌린다.
인접쌍 dE>=15(OKLab x100) 를 만족하는지 검증까지 한다."""
import math

def oklab_to_srgb(L, a, b):
    l_ = L + 0.3963377774*a + 0.2158037573*b
    m_ = L - 0.1055613458*a - 0.0638541728*b
    s_ = L - 0.0894841775*a - 1.2914855480*b
    l, m, s = l_**3, m_**3, s_**3
    r = +4.0767416621*l - 3.3077115913*m + 0.2309699292*s
    g = -1.2684380046*l + 2.6097574011*m - 0.3413193965*s
    bb = -0.0041960863*l - 0.7034186147*m + 1.7076147010*s
    def enc(c):
        c = 12.92*c if c <= 0.0031308 else 1.055*c**(1/2.4) - 0.055
        return max(0, min(255, round(c*255)))
    return enc(r), enc(g), enc(bb)

def lch_to_hex(L, C, h_deg):
    h = math.radians(h_deg)
    return "#%02x%02x%02x" % oklab_to_srgb(L, C*math.cos(h), C*math.sin(h))

def srgb_to_linear(c):
    c = c/255
    return c/12.92 if c <= 0.04045 else ((c+0.055)/1.055)**2.4

def hex_to_oklab(h):
    h = h.lstrip('#')
    r, g, b = (srgb_to_linear(int(h[i:i+2], 16)) for i in (0, 2, 4))
    l = 0.4122214708*r + 0.5363325363*g + 0.0514459929*b
    m = 0.2119034982*r + 0.6806995451*g + 0.1073969566*b
    s = 0.0883024619*r + 0.2817188376*g + 0.6299787005*b
    l_, m_, s_ = l**(1/3), m**(1/3), s**(1/3)
    return (0.2104542553*l_ + 0.7936177850*m_ - 0.0040720468*s_,
            1.9779984951*l_ - 2.4285922050*m_ + 0.4505937099*s_,
            0.0259040371*l_ + 0.7827717662*m_ - 0.8086757660*s_)

# 정상은 경보색을 쓰지 않는다(무채색 계열) — accent 청록과도 겹치지 않게 회녹색
SPEC = [
    ("정상",        0.66, 0.016,  165),
    ("관심",        0.82, 0.140,   88),
    ("주의",        0.70, 0.150,   62),
    ("경계",        0.575, 0.165,  36),
    ("심각/대발생", 0.435, 0.150,  27),
]
ramp = [(n, lch_to_hex(L, C, h)) for n, L, C, h in SPEC]

print(f"{'등급':<12} {'hex':<9} {'L':>6}")
labs = []
for n, hx in ramp:
    lab = hex_to_oklab(hx)
    labs.append((n, hx, lab))
    print(f"{n:<12} {hx:<9} {lab[0]*100:6.1f}")

print("\n인접쌍 분리:")
ok = True
for i in range(len(labs)-1):
    (n1, _, L1), (n2, _, L2) = labs[i], labs[i+1]
    dE = math.dist([v*100 for v in L1], [v*100 for v in L2])
    if dE < 15: ok = False
    print(f"  {n1:>11} → {n2:<12} dL={(L1[0]-L2[0])*100:+6.1f}  dE={dE:5.1f}  {'OK' if dE>=15 else '부족'}")

print("\n경보 4등급 명도 단조감소:",
      all(labs[i][2][0] > labs[i+1][2][0] for i in range(1, len(labs)-1)))

# 흰 글자를 얹을 배지이므로 대비도 확인 (WCAG relative luminance)
def rel_lum(hx):
    hx = hx.lstrip('#')
    r, g, b = (srgb_to_linear(int(hx[i:i+2], 16)) for i in (0, 2, 4))
    return 0.2126*r + 0.7152*g + 0.0722*b
print("\n배지 배경 대 흰 글자 대비:")
for n, hx, _ in labs:
    cr = 1.05 / (rel_lum(hx) + 0.05)
    print(f"  {n:<12} {hx}  {cr:4.2f}:1  {'흰글자 OK' if cr>=4.5 else '→ 어두운 글자 사용'}")
print("\n전체 판정:", "통과" if ok else "재조정 필요")

# ---- 채택안 검증 (tune_ramp.py 탐색 결과를 고정값으로 재확인) ----
FINAL = [("정상","#7e8984"),("관심","#ffd95a"),("주의","#e68920"),
         ("경계","#b8381a"),("심각/대발생","#6e040b")]
print("\n\n=== 채택안 재검증 ===")
labs = [(n, h, hex_to_oklab(h)) for n, h in FINAL]
for n, h, lab in labs:
    print(f"{n:<12} {h}  L={lab[0]*100:5.1f}")
worst = 1e9
for i in range(len(labs)-1):
    dE = math.dist([v*100 for v in labs[i][2]], [v*100 for v in labs[i+1][2]])
    worst = min(worst, dE)
    print(f"  {labs[i][0]:>11} → {labs[i+1][0]:<12} dE={dE:5.1f} {'OK' if dE>=15 else '부족'}")
print("최소 인접 dE =", round(worst,1), "→", "통과" if worst>=15 else "미달")
