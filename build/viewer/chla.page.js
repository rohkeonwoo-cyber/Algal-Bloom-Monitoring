
/* ---- 녹조 페이지 UI ----
   침수 페이지와 지형·카메라·조작·브이월드 타일을 공유하고(core.js), 여기서는 농도 표현만
   얹는다. 표현은 두 가지다.

     수면색 : 강물 자체를 농도색으로 칠한다. 수계가 한눈에 보이고 어디가 진한지 바로 읽힌다.
     리본   : 수면 위에 띄운 띠. 물이 좁은 상류에서도 색이 보인다(침수 화면에서 쓰던 방식).

   두 방식 모두 같은 값·같은 색을 쓴다(CHLA_RAMP). */

let mode = "surface", period = "all", surfMesh = null;

/* 날짜별 자료(chla_daily.json, 2.2 MB)는 고른 순간에만 받는다 — 처음부터 받으면
   평균 지도만 볼 사람에게도 2 MB 를 물린다. */
let DAILY = null, dayIdx = 0, playTimer = null;

/* 최근접 구간 찾기 — 정점마다 1,340개를 다 뒤지면 250만 × 1,340 회가 되어 멈춘다.
   2 km 격자에 구간 번호를 담아 두고 주변 9칸만 본다. */
const SEGIDX = {cell: 2000, map: null, minx: 0, miny: 0, nx: 0, ny: 0};
function buildSegIndex(){
  const segs = CHLA.segments;
  const xs = segs.map(s => s.x), ys = segs.map(s => s.y);
  SEGIDX.minx = Math.min(...xs) - SEGIDX.cell;
  SEGIDX.miny = Math.min(...ys) - SEGIDX.cell;
  SEGIDX.nx = Math.ceil((Math.max(...xs) + SEGIDX.cell - SEGIDX.minx) / SEGIDX.cell) + 1;
  SEGIDX.ny = Math.ceil((Math.max(...ys) + SEGIDX.cell - SEGIDX.miny) / SEGIDX.cell) + 1;
  SEGIDX.map = Array.from({length: SEGIDX.nx * SEGIDX.ny}, () => []);
  segs.forEach((s, i) => {
    const cx = Math.floor((s.x - SEGIDX.minx) / SEGIDX.cell);
    const cy = Math.floor((s.y - SEGIDX.miny) / SEGIDX.cell);
    SEGIDX.map[cy * SEGIDX.nx + cx].push(i);
  });
}
function nearestSeg(x, y, maxD){
  if(!SEGIDX.map) buildSegIndex();
  const cx = Math.floor((x - SEGIDX.minx) / SEGIDX.cell);
  const cy = Math.floor((y - SEGIDX.miny) / SEGIDX.cell);
  let best = -1, bd = maxD * maxD;
  for(let dy = -1; dy <= 1; dy++){
    for(let dx = -1; dx <= 1; dx++){
      const gx = cx + dx, gy = cy + dy;
      if(gx < 0 || gy < 0 || gx >= SEGIDX.nx || gy >= SEGIDX.ny) continue;
      for(const i of SEGIDX.map[gy * SEGIDX.nx + gx]){
        const s = CHLA.segments[i];
        const d = (s.x - x) ** 2 + (s.y - y) ** 2;
        if(d < bd){ bd = d; best = i; }
      }
    }
  }
  return best;
}

function segValue(s){
  if(period === "daily"){
    if(!DAILY) return null;
    const v = DAILY.values[dayIdx][s.idx];
    return v === null || v === undefined ? null : v / DAILY.scale;
  }
  return period === "jja" ? s.jja : s.all;
}

/* 색 범위 — 평균 지도는 그 지도의 최소~최대를 쓰고, **날짜별은 0~100 % 로 고정**한다.
   날마다 범위를 다시 잡으면 색이 같아도 뜻이 달라져 날짜를 비교할 수 없다. */
function valueRange(){
  if(period === "daily") return [0, 100];
  const v = CHLA.segments.map(segValue).filter(x => x !== null && x !== undefined);
  return [Math.min(...v), Math.max(...v)];
}

/* ---- 수면색 ---- */
function buildChlaSurface(){
  if(surfMesh){ group.remove(surfMesh); surfMesh.geometry.dispose(); surfMesh.material.dispose(); surfMesh = null; }
  if(mode !== "surface" || !CHLA) return;
  const D = DEPTHS["now"];
  if(!D) return;
  const {w, h} = TERR, res = META.res_m;
  const x0 = -(w - 1) * res / 2, z0 = -(h - 1) * res / 2;
  const [lo, hi] = valueRange();

  const idxOf = new Int32Array(w * h).fill(-1);
  const verts = [], cols = [], tris = [];
  const st = meshStep;
  // 강에서 3 km 넘게 떨어진 곳은 구간값을 붙이지 않는다(지류 골짜기까지 칠하지 않게)
  const MAXD = 3000;
  for(let r = 0; r < h; r += st){
    for(let c = 0; c < w; c += st){
      const i = r * w + c;
      const d = D.v[i] * META.depth_scale;
      if(d <= 0) continue;
      if(DIST && DIST.v[i] * (META.dist_scale || 1) > distLimit) continue;
      const x5 = X5186_0 + c * RES, y5 = Y5186_0 - r * RES;
      const si = nearestSeg(x5, y5, MAXD);
      const v = si < 0 ? null : segValue(CHLA.segments[si]);
      idxOf[i] = verts.length / 3;
      verts.push(x0 + c * res, elevRender(i) + d + 1.5, z0 + r * res);
      const col = v === null || v === undefined
        ? new THREE.Color("#5b7480")            // 값이 없는 구간(여름 결측 등)
        : chlaColor(v, lo, hi);
      cols.push(col.r, col.g, col.b);
    }
  }
  for(let r = 0; r + st < h; r += st){
    for(let c = 0; c + st < w; c += st){
      const a = idxOf[r*w + c], b = idxOf[r*w + c + st];
      const cc = idxOf[(r+st)*w + c], dd = idxOf[(r+st)*w + c + st];
      if(a < 0 || b < 0 || cc < 0 || dd < 0) continue;
      tris.push(a, cc, b, b, cc, dd);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  g.setIndex(tris);
  // 값을 나타내는 면이라 조명을 받지 않게 한다 — 음영이 끼면 같은 값이 달라 보인다.
  surfMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({vertexColors:true}));
  surfMesh.renderOrder = 2;
  group.add(surfMesh);
}

function applyMode(){
  chlaMode = (mode === "ribbon") ? period : "off";    // chla.js 의 리본은 mode 로 기간을 받는다
  buildChla();
  buildChlaSurface();
}

/* ---- 가리킨 지점: 그 자리의 구간값을 읽는다 ---- */
function updateReadout(clientX, clientY){
  const body = el("roBody");
  const g = pickPoint(clientX, clientY);
  if(!g){ body.innerHTML = `<div class="ro-none">지형 바깥입니다.</div>`; return; }
  const i = g.r * GW + g.c;
  const x5 = X5186_0 + g.c * RES, y5 = Y5186_0 - g.r * RES;
  const si = nearestSeg(x5, y5, 4000);
  const seg = si < 0 ? null : CHLA.segments[si];
  const d = DEPTHS["now"] ? DEPTHS["now"].v[i] * META.depth_scale : 0;
  body.innerHTML = seg ? `
    <div class="ro-row ro-depth"><span>초과빈도 (${period === "jja" ? "여름" : "전기간"})</span>
      <b>${segValue(seg) === null ? "자료 없음" : segValue(seg).toFixed(1) + " %"}</b></div>
    <div class="ro-row"><span>종단거리</span><b>${seg.s.toFixed(1)} km</b></div>
    <div class="ro-row"><span>담수역</span><b>${seg.pool}</b></div>
    <div class="ro-row"><span>현재 수위 수심</span><b>${d > 0 ? d.toFixed(2) + " m" : "잠기지 않음"}</b></div>`
    : `<div class="ro-none">가까운 본류 구간이 없습니다(4 km 밖).</div>`;
}

/* ---- 이동 ---- */
function flyTo(x5, y5, near){
  const c = Math.round((x5 - X5186_0) / RES), r = Math.round((Y5186_0 - y5) / RES);
  if(c < 0 || r < 0 || c >= GW || r >= GH) return;
  orbit.target.set(-SPANX/2 + c*RES, elevAt(r*GW + c) * vex, -SPANZ/2 + r*RES);
  orbit.dist = SPANX * (near || 0.09);
  orbit.phi = 0.42;
  applyCamera();
}

/* ---- 종단 분포 그래프 ---- */
function drawProfile(){
  const box = el("profile");
  if(!CHLA){ box.innerHTML = ""; return; }
  const W = 250, H = 92, PAD = 16;
  const pts = CHLA.segments.filter(s => segValue(s) !== null && segValue(s) !== undefined);
  if(!pts.length){ box.innerHTML = `<div class="ro-none">이 기간 자료가 없습니다.</div>`; return; }
  const smax = Math.max(...pts.map(s => s.s)), vmax = Math.max(...pts.map(segValue));
  const X = s => PAD + (s / smax) * (W - PAD - 4);
  const Y = v => H - 14 - (v / vmax) * (H - 26);
  const path = pts.map((s, i) => `${i ? "L" : "M"}${X(s.s).toFixed(1)},${Y(segValue(s)).toFixed(1)}`).join("");
  const top = [...pts].sort((a, b) => segValue(b) - segValue(a)).slice(0, 5);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img"
      aria-label="종단거리별 Chl-a 초과빈도">
    <line x1="${PAD}" y1="${H-14}" x2="${W-4}" y2="${H-14}" stroke="#2b414b"/>
    <path d="${path}" fill="none" stroke="#2fb6bd" stroke-width="1.2"/>
    ${top.map(s => `<circle cx="${X(s.s).toFixed(1)}" cy="${Y(segValue(s)).toFixed(1)}" r="2.6"
        fill="${"#" + chlaColor(segValue(s), ...valueRange()).getHexString()}"
        stroke="#0d1518" stroke-width="0.8"><title>${s.s} km · ${segValue(s)}%</title></circle>`).join("")}
    <text x="${PAD}" y="${H-3}" fill="#72898d" font-size="8">하구 0</text>
    <text x="${W-4}" y="${H-3}" fill="#72898d" font-size="8" text-anchor="end">${smax.toFixed(0)} km</text>
    <text x="${PAD}" y="10" fill="#72898d" font-size="8">최대 ${vmax.toFixed(0)}%</text>
  </svg>`;
  box.querySelector("svg").addEventListener("click", ev => {
    const r = ev.currentTarget.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * W;
    const s = ((sx - PAD) / (W - PAD - 4)) * smax;
    const near = pts.reduce((b, p) => Math.abs(p.s - s) < Math.abs(b.s - s) ? p : b, pts[0]);
    flyTo(near.x, near.y);
  });
}

/* ---- 목록 ---- */
function drawHotList(){
  const box = el("hotList");
  const pts = CHLA.segments.filter(s => segValue(s) !== null && segValue(s) !== undefined);
  const top = [...pts].sort((a, b) => segValue(b) - segValue(a)).slice(0, 10);
  const [lo, hi] = valueRange();
  box.innerHTML = top.map(s => `
    <button class="hot" data-x="${s.x}" data-y="${s.y}">
      <i style="background:${"#" + chlaColor(segValue(s), lo, hi).getHexString()}"></i>
      <span class="nm">${s.s.toFixed(1)} km<small>담수역 ${s.pool}</small></span>
      <b class="mono">${segValue(s).toFixed(1)}%</b>
    </button>`).join("");
  box.querySelectorAll(".hot").forEach(b => b.addEventListener("click",
    () => flyTo(Number(b.dataset.x), Number(b.dataset.y))));
}

function drawStationList(){
  const box = el("stationList");
  const sts = (CHLA && CHLA.stations) || [];
  const now = {};
  ((ALGAE_NOW && ALGAE_NOW.rows) || []).forEach(r => { now[r.station] = r; });
  box.innerHTML = sts.map(s => {
    const r = now[s.name];
    return `<button class="hot" data-x="${s.x}" data-y="${s.y}">
      <i style="background:${r && ALGAE_LV_FILL[r.level] || "#3a4a4f"}"></i>
      <span class="nm">${s.name}<small>${s.s.toFixed(1)} km</small></span>
      <b class="mono">${r && r.level ? r.level : "–"}</b>
    </button>`;
  }).join("");
  box.querySelectorAll(".hot").forEach(b => b.addEventListener("click",
    () => flyTo(Number(b.dataset.x), Number(b.dataset.y))));
  el("algaeNote").textContent = ALGAE_NOW
    ? `조류경보 단계는 ${ALGAE_NOW.updated_at.slice(0, 10)} 수집분입니다.`
    : "조류경보 현황을 불러오지 못했습니다.";
}

/* ---- 날짜별 ---- */
async function loadDaily(){
  if(DAILY) return DAILY;
  const st = el("dayInfo");
  if(st) st.textContent = "날짜별 자료 받는 중… (2.2 MB)";
  const r = await fetch("../flood/chla_daily.json", {cache:"force-cache"});
  if(!r.ok) throw new Error("chla_daily.json " + r.status);
  DAILY = await r.json();
  // 구간 순서가 chla.json 과 같아야 값이 제자리에 붙는다. 어긋나면 **조용히 틀린 지도**가
  // 되므로 종단거리로 확인한다(맞으면 색인만 붙인다).
  const bad = CHLA.segments.length !== DAILY.n_seg
    || CHLA.segments.some((g, i) => Math.abs(g.s - DAILY.s_km[i]) > 0.05);
  if(bad){ DAILY = null; throw new Error("구간 순서가 달라 날짜별 값을 붙일 수 없습니다"); }
  CHLA.segments.forEach((g, i) => { g.idx = i; });
  dayIdx = DAILY.dates.length - 1;          // 가장 최근 날짜부터
  return DAILY;
}

function dayLabel(){
  const cov = DAILY.cover[dayIdx], pct = cov / DAILY.n_seg * 100;
  return `${DAILY.dates[dayIdx]} · 관측 ${cov.toLocaleString()}/${DAILY.n_seg.toLocaleString()}구간 (${pct.toFixed(0)}%)`;
}

function syncDay(){
  const sl = el("daySlider");
  if(sl) sl.value = String(dayIdx);
  const inf = el("dayInfo");
  if(inf) inf.textContent = dayLabel();
  applyMode(); drawHotList(); drawProfile();
}

function stopPlay(){
  clearInterval(playTimer); playTimer = null;
  const b = el("dayPlay"); if(b) b.textContent = "▶ 재생";
}

function buildDayUI(){
  const box = el("dayBox");
  if(!box) return;
  box.hidden = false;
  box.innerHTML = `
    <div class="ctl">
      <button id="dayPrev" class="daybtn">◀</button>
      <input type="range" id="daySlider" min="0" max="${DAILY.dates.length - 1}" value="${dayIdx}">
      <button id="dayNext" class="daybtn">▶</button>
    </div>
    <div class="ctl"><button id="dayPlay" class="daybtn wide">▶ 재생</button></div>
    <div class="swnote" id="dayInfo">${dayLabel()}</div>
    <div class="swnote"><b>하루치 값은 '초과빈도'가 아닙니다.</b>
      그날 관측된 화소 중 25 mg/m³ 를 넘은 비율입니다. 회색은 그날 구름 등으로
      관측되지 않은 구간입니다 — 농도가 낮다는 뜻이 아닙니다.</div>`;
  el("daySlider").addEventListener("input", e => { stopPlay(); dayIdx = +e.target.value; syncDay(); });
  el("dayPrev").addEventListener("click", ()=>{ stopPlay(); dayIdx = Math.max(0, dayIdx - 1); syncDay(); });
  el("dayNext").addEventListener("click", ()=>{
    stopPlay(); dayIdx = Math.min(DAILY.dates.length - 1, dayIdx + 1); syncDay(); });
  el("dayPlay").addEventListener("click", ()=>{
    if(playTimer){ stopPlay(); return; }
    el("dayPlay").textContent = "■ 정지";
    playTimer = setInterval(()=>{
      dayIdx = (dayIdx + 1) % DAILY.dates.length;
      syncDay();
    }, 700);
  });
}

/* ---- 담수역 선택 (침수 페이지와 같은 방식) ---- */
const POOL = new URLSearchParams(location.search).get("pool");
const POOL_BASE = POOL !== null && /^[0-8]$/.test(POOL) ? `../flood/pools/p${POOL}/` : "../flood/";

async function buildPoolPicker(){
  const box = el("poolPick");
  let idx = null;
  try{
    const r = await fetch("../flood/pools/index.json", {cache:"no-store"});
    if(r.ok) idx = await r.json();
  }catch(e){ /* 없으면 전 구간만 */ }
  if(!idx){ box.innerHTML = `<div class="ro-none">구간 자료가 아직 없습니다.</div>`; return; }
  const cur = POOL !== null ? Number(POOL) : null;
  const mk = (label, sub, href, on) =>
    `<a class="poolbtn${on ? " on" : ""}" href="${href}"><span class="nm">${label}</span>` +
    `<span class="km2 mono">${sub}</span></a>`;
  box.innerHTML = mk("전 구간", "90 m · 268 km", "?", cur === null)
    + idx.pools.map(p => mk(`담수역 ${p.pool}`, `30 m · ${p.s_range_km[0]}~${p.s_range_km[1]}km`,
                            `?pool=${p.pool}`, cur === p.pool)).join("");
}

const PAGE = {
  base: POOL_BASE,
  chlaUrl: "../flood/chla.json",
  algaeUrl: "../data/algae_latest.json",
  buildUI(meta){
    el("reachLabel").textContent = POOL !== null
      ? `담수역 ${POOL} (종단 ${meta.s_range_km[0]}~${meta.s_range_km[1]} km) · 지형격자 ${meta.res_m} m`
      : `본류 전 구간 (0~${meta.reach.s_hi} km) · 지형격자 ${meta.res_m} m`;
    buildPoolPicker();
    wireControls(meta);

    if(!CHLA){
      el("chlaMode").innerHTML = `<div class="ro-none">녹조 자료(chla.json)를 불러오지 못했습니다.</div>`;
      return;
    }
    el("chlaAllR").textContent = `${CHLA.range_all[0]}~${CHLA.range_all[1]}%`;
    el("chlaJjaR").textContent = `${CHLA.range_jja[0]}~${CHLA.range_jja[1]}%`;

    const syncBtns = () => {
      document.querySelectorAll("#chlaMode button").forEach(b =>
        b.setAttribute("aria-pressed", String(b.dataset.m === mode)));
      document.querySelectorAll("#chlaPeriod button").forEach(b =>
        b.setAttribute("aria-pressed", String(b.dataset.p === period)));
    };
    document.querySelectorAll("#chlaMode button").forEach(b =>
      b.addEventListener("click", () => { mode = b.dataset.m; syncBtns(); applyMode(); }));
    document.querySelectorAll("#chlaPeriod button").forEach(b =>
      b.addEventListener("click", async () => {
        const want = b.dataset.p;
        if(want === "daily"){
          try{ await loadDaily(); }
          catch(e){ el("dayInfo") && (el("dayInfo").textContent = "날짜별 자료를 불러오지 못했습니다: " + e.message); return; }
          period = want; syncBtns(); buildDayUI(); syncDay(); drawLegend();
          return;
        }
        stopPlay();
        const box = el("dayBox"); if(box) box.hidden = true;
        period = want; syncBtns(); applyMode(); drawHotList(); drawProfile(); drawLegend();
      }));
    syncBtns();
  },
  async onReady(meta){
    current = "now";              // 녹조는 '현재 수위' 수면 위에서 본다
    buildWater(current);
    if(!CHLA) return;

    /* 링크로 기간·날짜를 바로 열 수 있게 한다 — ?p=daily&d=2022-08-10 (또는 ?d=350 색인) */
    const q = new URLSearchParams(location.search);
    if(q.get("p") === "daily"){
      try{
        await loadDaily();
        const d = q.get("d");
        if(d){
          // 관측이 있는 날만 목록에 있다 — 없는 날짜를 주면 가장 가까운 관측일로 맞춘다.
          if(/^\d+$/.test(d)){
            const i = +d;
            if(i >= 0 && i < DAILY.dates.length) dayIdx = i;
          } else {
            let best = -1, bd = Infinity;
            const want = Date.parse(d);
            DAILY.dates.forEach((x, i) => {
              const gap = Math.abs(Date.parse(x) - want);
              if(gap < bd){ bd = gap; best = i; }
            });
            if(best >= 0) dayIdx = best;
          }
        }
        period = "daily";
        document.querySelectorAll("#chlaPeriod button").forEach(b =>
          b.setAttribute("aria-pressed", String(b.dataset.p === "daily")));
        buildDayUI(); syncDay(); drawLegend(); drawStationList();
        return;
      }catch(e){ /* 실패하면 평균 지도로 진행 */ }
    }
    applyMode();
    drawAlgaeStations();
    drawHotList();
    drawStationList();
    drawProfile();
    drawLegend();
  },
};

function drawLegend(){
  const [lo, hi] = valueRange();
  el("chlaSwatches").innerHTML =
    `<i style="position:absolute;inset:0;background:linear-gradient(90deg,${CHLA_RAMP.join(",")})"></i>`;
  el("chlaLo").textContent = lo.toFixed(0) + "%";
  el("chlaMid").textContent = ((lo + hi) / 2).toFixed(0) + "%";
  el("chlaHi").textContent = hi.toFixed(0) + "%";
}


/* 격자 간격·표시 범위가 바뀌면 수면색도 같은 격자로 다시 만든다(controls.js 가 부른다). */
function onGridChange(){ buildChlaSurface(); }
