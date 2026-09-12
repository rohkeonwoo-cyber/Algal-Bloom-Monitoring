"""EPSG:5186 → WGS84 역투영(TM inverse)을 직접 구현하고 pyproj와 대조한다.
브이월드 타일은 Web Mercator 이므로, 지형 격자(5186) 정점마다 위경도를 알아야
어느 타일의 어느 위치에 해당하는지 계산할 수 있다."""
import math

A = 6378137.0
FL = 1.0 / 298.257222101
E2 = 2 * FL - FL * FL
EP2 = E2 / (1 - E2)
E1 = (1 - math.sqrt(1 - E2)) / (1 + math.sqrt(1 - E2))
LAT0 = math.radians(38.0)
LON0 = math.radians(127.0)
X0, Y0 = 200000.0, 600000.0


def _M(phi):
    e2 = E2
    return A * ((1 - e2/4 - 3*e2**2/64 - 5*e2**3/256) * phi
                - (3*e2/8 + 3*e2**2/32 + 45*e2**3/1024) * math.sin(2*phi)
                + (15*e2**2/256 + 45*e2**3/1024) * math.sin(4*phi)
                - (35*e2**3/3072) * math.sin(6*phi))


M0 = _M(LAT0)


def tm_inverse(x, y):
    """(x, y) EPSG:5186 → (lon, lat) 도 단위. 표준 TM 역변환 급수."""
    M = M0 + (y - Y0)          # k0 = 1
    mu = M / (A * (1 - E2/4 - 3*E2**2/64 - 5*E2**3/256))
    phi1 = (mu
            + (3*E1/2 - 27*E1**3/32) * math.sin(2*mu)
            + (21*E1**2/16 - 55*E1**4/32) * math.sin(4*mu)
            + (151*E1**3/96) * math.sin(6*mu)
            + (1097*E1**4/512) * math.sin(8*mu))
    C1 = EP2 * math.cos(phi1)**2
    T1 = math.tan(phi1)**2
    N1 = A / math.sqrt(1 - E2 * math.sin(phi1)**2)
    R1 = A * (1 - E2) / (1 - E2 * math.sin(phi1)**2)**1.5
    D = (x - X0) / N1
    lat = phi1 - (N1 * math.tan(phi1) / R1) * (
        D*D/2
        - (5 + 3*T1 + 10*C1 - 4*C1*C1 - 9*EP2) * D**4 / 24
        + (61 + 90*T1 + 298*C1 + 45*T1*T1 - 252*EP2 - 3*C1*C1) * D**6 / 720)
    lon = LON0 + (D
                  - (1 + 2*T1 + C1) * D**3 / 6
                  + (5 - 2*C1 + 28*T1 - 3*C1*C1 + 8*EP2 + 24*T1*T1) * D**5 / 120) / math.cos(phi1)
    return math.degrees(lon), math.degrees(lat)


# 지형 격자 bbox 네 귀퉁이 + 내부 격자점
MINX, MAXX, MINY, MAXY = 309280.0, 353210.0, 298010.0, 345530.0
TESTS = [(x, y) for x in (MINX, (MINX+MAXX)/2, MAXX)
                for y in (MINY, (MINY+MAXY)/2, MAXY)]
TESTS += [(200000.0, 600000.0), (330000.0, 320000.0), (312345.0, 301234.0)]

from pyproj import Transformer
tr = Transformer.from_crs("EPSG:5186", "EPSG:4326", always_xy=True)
print(f"{'x':>10}{'y':>10} | {'dlon(m)':>10}{'dlat(m)':>10}")
worst = 0.0
for x, y in TESTS:
    plon, plat = tr.transform(x, y)
    mlon, mlat = tm_inverse(x, y)
    # 각도차를 거리로 환산해 비교
    dlon = (mlon - plon) * 111320 * math.cos(math.radians(plat))
    dlat = (mlat - plat) * 110540
    worst = max(worst, abs(dlon), abs(dlat))
    print(f"{x:10.0f}{y:10.0f} | {dlon:10.6f}{dlat:10.6f}")
print(f"\n최대 절대오차: {worst*1000:.4f} mm")
print(f"브이월드 최고화질 화소(0.24 m) 기준 오차: {worst/0.24:.6f} 화소")
