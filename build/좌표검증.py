"""EPSG:5186(Korea 2000 / Central Belt 2010) 순전방 TM 투영을 직접 구현하고
pyproj 결과와 대조한다. JS로 그대로 옮길 식이므로 오차를 눈으로 확인해야 한다."""
import math

# EPSG:5186 = tmerc, lat_0=38, lon_0=127, k=1, x_0=200000, y_0=600000, GRS80
A = 6378137.0
F_INV = 298.257222101          # GRS80
FL = 1.0 / F_INV
E2 = 2 * FL - FL * FL
LAT0 = math.radians(38.0)
LON0 = math.radians(127.0)
K0 = 1.0
X0, Y0 = 200000.0, 600000.0

def _M(phi):
    """자오선호장(meridional arc). 표준 4항 급수."""
    e2 = E2
    return A * ((1 - e2/4 - 3*e2**2/64 - 5*e2**3/256) * phi
                - (3*e2/8 + 3*e2**2/32 + 45*e2**3/1024) * math.sin(2*phi)
                + (15*e2**2/256 + 45*e2**3/1024) * math.sin(4*phi)
                - (35*e2**3/3072) * math.sin(6*phi))

M0 = _M(LAT0)

def tm_forward(lon_deg, lat_deg):
    phi = math.radians(lat_deg)
    lam = math.radians(lon_deg)
    e2 = E2
    ep2 = e2 / (1 - e2)
    N = A / math.sqrt(1 - e2 * math.sin(phi)**2)
    T = math.tan(phi)**2
    C = ep2 * math.cos(phi)**2
    Aa = (lam - LON0) * math.cos(phi)
    M = _M(phi)
    x = X0 + K0 * N * (Aa + (1 - T + C) * Aa**3 / 6
                       + (5 - 18*T + T*T + 72*C - 58*ep2) * Aa**5 / 120)
    y = Y0 + K0 * (M - M0 + N * math.tan(phi) * (
        Aa**2 / 2 + (5 - T + 9*C + 4*C*C) * Aa**4 / 24
        + (61 - 58*T + T*T + 600*C - 330*ep2) * Aa**6 / 720))
    return x, y

# 연구범위를 고르게 덮는 검정점 (낙동강 유역 + bbox 네 귀퉁이 근처)
TESTS = [
    (128.14, 35.05), (129.10, 35.05), (128.14, 36.60), (129.10, 36.60),
    (128.9800, 35.1100),   # 물금매리 부근
    (128.5000, 35.3500),   # 칠서 부근
    (128.4500, 35.8300),   # 강정고령 부근
    (128.3000, 36.1200),   # 해평 부근
    (127.0000, 38.0000),   # 투영 원점 (x=200000, y=600000 이어야 함)
    (128.6000, 35.9000), (128.2000, 35.5000), (129.0000, 36.2000),
]

from pyproj import Transformer
tr = Transformer.from_crs("EPSG:4326", "EPSG:5186", always_xy=True)

print(f"{'lon':>9} {'lat':>8} | {'dx(m)':>10} {'dy(m)':>10}")
worst = 0.0
for lon, lat in TESTS:
    px, py = tr.transform(lon, lat)
    mx, my = tm_forward(lon, lat)
    dx, dy = mx - px, my - py
    worst = max(worst, abs(dx), abs(dy))
    print(f"{lon:9.4f} {lat:8.4f} | {dx:10.6f} {dy:10.6f}")
print(f"\n최대 절대오차: {worst:.6f} m")

# SVG 좌표 오차로 환산: 900px 이 (400570-293610)=106960 m 를 덮음
m_per_px = (400570.0 - 293610.0) / (900 * (1 - 2*0.03))
print(f"1 px = {m_per_px:.1f} m  →  최대오차는 {worst/m_per_px:.6f} px")
