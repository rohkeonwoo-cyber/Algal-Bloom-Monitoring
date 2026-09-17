
/* ---- 실시간 수위로 침수 계산 ----
   미리 만들어 둔 5단계 시나리오 대신, **관측된 수위**로 수면을 만든다.

     수면표고(EL.m) = 관측수위 + 수위표 영점표고(gdt)      ← 10b 에서 확인한 관계
     담수역 안에서 관측소 종단거리(s)를 따라 선형보간
     수심 = 수면표고(그 칸의 s) − 지면표고

   격자마다 "가장 가까운 본류 지점의 s" 가 필요해 schan.png 를 따로 내보냈다(10i).

   **한계** — 연결성 판정을 매번 다시 하지 않는다. 대신 심각수위에서 물이 닿았던 범위
   (depth_srs > 0) 안으로 제한한다. 고립 저지대가 갑자기 잠기는 것은 막지만 수리 계산은
   아니다. 화면에도 적는다. */

const LIVE = {
  rows: null,         // 실시간 수위 관측소
  gauges: [],         // 이 화면 범위의 관측소 (meta.gauges 와 이름으로 연결)
  hours: [],          // 시각 라벨
  idx: 0,             // 지금 보고 있는 시각
  depth: null,        // 계산된 수심 격자 (cm, uint16) — DEPTHS.live 로 꽂는다
  ready: false,
};

function hourLabel(t0, k){
  // t0 는 YYYYMMDDHH. k 시간 뒤의 라벨을 만든다.
  const y = +t0.slice(0,4), mo = +t0.slice(4,6), d = +t0.slice(6,8), h = +t0.slice(8,10);
  const dt = new Date(Date.UTC(y, mo-1, d, h) + k*3600e3);
  const p = n => String(n).padStart(2, "0");
  return `${p(dt.getUTCMonth()+1)}.${p(dt.getUTCDate())} ${p(dt.getUTCHours())}시`;
}

async function loadLive(){
  const r = await fetch("../data/hrfco_waterlevel.json", {cache:"no-store"});
  if(!r.ok) throw new Error("수위 자료 " + r.status);
  const j = await r.json();
  LIVE.rows = {};
  (j.rows || []).forEach(x => { LIVE.rows[x.name] = x; });

  // 이 화면에 포함된 관측소 중 계열이 있는 것만
  LIVE.gauges = (META.gauges || [])
    .map(g => ({...g, live: LIVE.rows[g.name]}))
    .filter(g => g.live && Array.isArray(g.live.series) && g.gdt !== null && g.gdt !== undefined);
  if(!LIVE.gauges.length) throw new Error("이 구간에는 실시간 수위 관측소가 없습니다");

  const t0 = LIVE.gauges[0].live.series_t0;
  const n = Math.max(...LIVE.gauges.map(g => g.live.series.length));
  LIVE.hours = Array.from({length: n}, (_, k) => hourLabel(t0, k));
  LIVE.idx = n - 1;
  LIVE.ready = true;
  return LIVE;
}

/* 담수역 안에서 s 를 따라 수면표고를 보간한다. 담수역 경계(보)를 넘어 섞지 않는다 —
   보를 사이에 두고 수위가 다르기 때문이다(10c 와 같은 처리). */
function wseProfile(k){
  const byPool = new Map();
  for(const g of LIVE.gauges){
    const wl = g.live.series[k];
    if(wl === null || wl === undefined) continue;
    if(!byPool.has(g.pool)) byPool.set(g.pool, []);
    byPool.get(g.pool).push({s: g.s, el: wl + g.gdt, name: g.name});
  }
  for(const arr of byPool.values()) arr.sort((a, b) => a.s - b.s);
  return byPool;
}

function wseAt(prof, pool, s){
  const a = prof.get(pool);
  if(!a || !a.length) return null;
  if(s <= a[0].s) return a[0].el;
  if(s >= a[a.length-1].s) return a[a.length-1].el;
  for(let i = 1; i < a.length; i++){
    if(s <= a[i].s){
      const t = (s - a[i-1].s) / (a[i].s - a[i-1].s);
      return a[i-1].el + t * (a[i].el - a[i-1].el);
    }
  }
  return null;
}

/* 격자별 수심을 계산해 DEPTHS.live 에 넣는다. */
function computeLiveDepth(k){
  if(!SCHAN || !DEPTHS.srs) return null;
  const prof = wseProfile(k);
  if(!prof.size) return null;

  /* s → 담수역 번호: 가장 가까운 관측소의 담수역을 쓴다. 관측소는 담수역마다 있고
     보를 경계로 나뉘므로, 구간 자료가 없는 침수 페이지에서도 이 방법이면 충분하다. */
  const gs = LIVE.gauges.slice().sort((a, b) => a.s - b.s);
  const poolOf = s => {
    let best = gs[0], bd = Infinity;
    for(const g of gs){ const d = Math.abs(g.s - s); if(d < bd){ bd = d; best = g; } }
    return best.pool;
  };

  // s 는 0.1 km 단위로만 구분되므로, s 값마다 수면표고를 미리 계산해 표로 둔다(2,681칸).
  const lut = new Float32Array(2681).fill(NaN);
  for(let i = 0; i < lut.length; i++){
    const s = i / 10, w = wseAt(prof, poolOf(s), s);
    if(w !== null) lut[i] = w;
  }

  const n = TERR.v.length, out = new Uint16Array(n);
  const srs = DEPTHS.srs.v, sch = SCHAN.v;
  const es = META.elev_scale, eo = META.elev_offset_m, ds = META.depth_scale;
  let wet = 0, maxd = 0;
  for(let i = 0; i < n; i++){
    if(srs[i] === 0) continue;                 // 심각수위에도 물이 닿지 않은 곳 — 제외
    const si = sch[i];
    if(si >= 65535) continue;
    const w = lut[si];
    if(!(w > -1e9)) continue;
    const d = w - (TERR.v[i] * es + eo);
    if(d <= 0) continue;
    const cm = Math.min(65534, Math.round(d / ds));
    out[i] = cm; wet++;
    if(d > maxd) maxd = d;
  }
  LIVE.depth = {w: TERR.w, h: TERR.h, v: out};
  const areaKm2 = wet * (META.res_m * META.res_m) / 1e6;
  return {areaKm2, maxd, wet};
}
