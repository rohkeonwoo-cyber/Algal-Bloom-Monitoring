const SCEN_COLOR = {now:"#7e8984", att:"#ffd95a", wrn:"#e68920", alm:"#b8381a", srs:"#6e040b"};
// 수심 색: 단일 색상(파랑) 명도 순차 — 얕음(밝음) → 깊음(어두움)
const DEPTH_RAMP = ["#9fd8ef","#66b7e0","#3d92cd","#2a6fb0","#1d4f8f","#123467"];
function updateReadout(clientX, clientY){
  const body = el("roBody");
  const g = pickPoint(clientX, clientY);
  if(!g){
    body.innerHTML = `<div class="ro-none">지형 바깥입니다. 지형 위에 마우스를 올려주세요.</div>`;
    return;
  }
  const i = g.r * GW + g.c;
  const elev = elevAt(i);
  const D = DEPTHS[current];
  let depth = D ? D.v[i] * META.depth_scale : 0;
  const distKm = DIST ? DIST.v[i] * (META.dist_scale || 1) / 1000 : null;
  if(DIST && distKm * 1000 > distLimit) depth = 0;     // 화면에서 잘라낸 곳은 0 으로 읽는다
  const lon = META.bounds_4326[0] + (g.c/(GW-1)) * (META.bounds_4326[2] - META.bounds_4326[0]);
  const lat = META.bounds_4326[3] - (g.r/(GH-1)) * (META.bounds_4326[3] - META.bounds_4326[1]);
  // 하도 화소(본류 거리 0)는 DEM 값이 하상이 아니라 레이더 촬영 당시 수면이다
  const inChannel = distKm !== null && distKm === 0;
  const ch = META.channel || {};
  body.innerHTML = `
    <div class="ro-row ro-depth"><span>${inChannel ? "수면 대비 수심" : "수심"}</span>
      <b style="color:${depth > 0 ? "#2a6fb0" : "var(--ink-3)"}">${depth > 0 ? depth.toFixed(2)+" m" : "잠기지 않음"}</b></div>
    <div class="ro-row"><span>${inChannel ? "DEM 표고(수면)" : "지면 표고"}</span><b>${elev.toFixed(1)} m</b></div>
    ${depth > 0 ? `<div class="ro-row"><span>수면 표고</span><b>${(elev+depth).toFixed(1)} m</b></div>` : ""}
    <div class="ro-row"><span>본류 거리</span><b>${distKm === null ? "–" : distKm.toFixed(1)+" km"}</b></div>
    <div class="ro-row"><span>좌표</span><b style="font-size:11px">${lat.toFixed(4)}, ${lon.toFixed(4)}</b></div>
    ${inChannel ? `<div class="ro-warn"><b>하도 안입니다.</b> 이 표고는 하상이 아니라
      레이더가 찍은 <b>당시 수면</b>입니다 — 레이더는 물을 투과하지 못합니다.
      실제 하상은 이보다 더 아래이고(담수역 평균수심 ${ch.pool_mean_depth_m ?? "–"} m),
      여기 적힌 수심은 하상까지의 깊이가 아닙니다.</div>` : ""}`;
  if(!pickMark){
    pickMark = new THREE.Mesh(new THREE.SphereGeometry(RES*1.2, 12, 8),
                              new THREE.MeshBasicMaterial({color:0x2fb6bd}));
    pickMark.renderOrder = 2;
    group.add(pickMark);
  }
  pickMark.visible = true;
  pickMark.position.set(-SPANX/2 + g.c*RES, elev + depth, -SPANZ/2 + g.r*RES);
  pickMark.scale.setScalar(Math.max(0.6, orbit.dist / SPANX * 2.2));
}
let pickMark = null;
// ---------- UI ----------
function buildUI(meta){
  el("reachLabel").textContent =
    `낙동강 본류 전 구간 (하구둑~영강합류부, 종단 ${meta.reach.s_lo}~${meta.reach.s_hi} km)`
    + ` · 지형격자 ${meta.res_m} m`;

  const list = el("scenList");
  meta.scenarios.forEach(s=>{
    const b = document.createElement("button");
    b.dataset.key = s.key;
    b.setAttribute("aria-pressed", "false");
    b.innerHTML = `<i style="background:${SCEN_COLOR[s.key]}"></i>`
      + `<span class="nm">${s.label}</span>`
      + `<span class="km2 mono">${s.area_km2} km²</span>`;
    b.addEventListener("click", ()=> select(s.key));
    list.appendChild(b);
  });

  const go = el("goto");
  const goItems = [];
  (meta.gauges || []).filter(g => g.x !== undefined).forEach(g =>
    goItems.push({x:g.x, y:g.y, s:g.s, label:`${g.name} · ${g.s.toFixed(1)}km`}));
  goItems.sort((a, b) => a.s - b.s).forEach(it=>{
    const o = document.createElement("option");
    o.value = `${it.x},${it.y}`;
    o.textContent = it.label;
    go.appendChild(o);
  });
  go.addEventListener("change", ()=>{
    if(!go.value){ frameCamera(SPANX, SPANZ); return; }   // 전체 보기로 복귀
    const [gx, gy] = go.value.split(",").map(Number);
    // 5186 → 격자 인덱스 → 화면(world) 좌표. 정점은 화소 중심에 있다.
    const c = Math.round((gx - X5186_0) / RES), r = Math.round((Y5186_0 - gy) / RES);
    if(c < 0 || r < 0 || c >= GW || r >= GH) return;
    orbit.target.set(-SPANX/2 + c*RES, elevAt(r*GW + c) * vex, -SPANZ/2 + r*RES);
    orbit.dist = SPANX * 0.09;
    orbit.phi = 0.42;
    applyCamera();
  });

  wireControls(meta);
  wireLive();

  const tex = meta.texture;
  el("methodNote").innerHTML = `
    <b>해발표고 = 관측수위 + 수위표 영점표고(gdt).</b> 담수역별 관심수위 표고가 하류→상류로
    단조 증가하고(3.1→48.6 m), DEM 수면과 평균 +0.71 m 차이로 맞는 것을 확인했습니다.<br><br>
    <b>수면종단</b>은 담수역(보~보) 안에서만 관측소 표고를 종단거리로 선형보간했습니다.
    기관이 지점별로 정한 기준수위는 서로 정합되지 않아 종단이 역전되는 곳이 있어,
    등위회귀로 최소한만 단조 보정했습니다(보정된 지점 수는 아래 표기).<br><br>
    <b>침수 판정</b>은 각 화소에 가장 가까운 하도의 수면표고를 주고 DEM 보다 높으면 잠긴 것으로
    보되, 하도와 이어지지 않은 고립 저지대는 제외했습니다.<br><br>
    지형: Copernicus DEM GLO-30 (30 m, 화면은 ${meta.res_m} m 로 축소).
    ${tex ? `위성: Sentinel-2 L2A ${tex.scenes.map(s=>s.date).join(", ")} (운량 ${tex.scenes[0].cloud}%).` : ""}
    수위: 한강홍수통제소 Open API.`;
}

function select(key){
  current = key;
  // 다른 파라미터(pool·at·bld…)를 지우지 않도록 s 만 바꿔 쓴다
  try{
    const u = new URL(location.href);
    u.searchParams.set("s", key);
    history.replaceState(null, "", u);
  }catch(e){}
  const s = META.scenarios.find(x => x.key === key);
  document.querySelectorAll("#scenList button").forEach(b=>
    b.setAttribute("aria-pressed", String(b.dataset.key === key)));
  const maxD = buildWater(key);
  if(typeof invalidateBuildings === "function") invalidateBuildings();  // 잠김 판정이 바뀐다
  el("stArea").textContent = s.area_km2;
  el("stOff").textContent = s.offchannel_km2;
  el("stDepth").textContent = s.depth_mean_m ?? "–";
  el("stMax").textContent = s.max_depth_m ?? "–";
  el("swMax").textContent = maxD.toFixed(1) + " m";
  el("swMid").textContent = (maxD/2).toFixed(1) + " m";
  el("depthSwatches").innerHTML = `<i style="background:linear-gradient(90deg,${
    Array.from({length:9}, (_, k) => waterCss(maxD * k/8, k/8*100)).join(",")})"></i>`;

  const adj = s.adjusted_gauges;
  el("valNote").innerHTML = `
    이 시나리오의 침수역 중 <b>${s.gsw_any_precision}%</b> 가 위성이 관측한 수면 흔적
    (JRC Global Surface Water) 위에 있고, 상시수면의 <b>${s.gsw_permanent_recall}%</b> 를 재현합니다.
    시나리오가 커질수록 앞 수치가 낮아지는 것은 정상입니다 — 홍수터는 평소 물이 없으니까요.<br><br>
    단조 보정된 관측소 ${adj}개 · 하도 비연결 고립부 ${s.dropped_isolated_km2} km² 제외.<br><br>
    <b>수리모형이 아닙니다.</b> DEM 이 수목·건물 높이를 포함하는 DSM 이고(침수 과소추정),
    30 m 로는 제방·도로를 해상하지 못하며, 통수능·부정류 계산이 없습니다.
    특정 지점의 침수 여부 판정에는 쓸 수 없는 <b>지형 기반 근사</b>입니다.<br><br>
    <b>하도 안의 수심은 실제 하천 수심이 아닙니다.</b> Copernicus DEM 은 레이더 기반이라
    물을 투과하지 못해, 하도 화소의 표고는 하상이 아니라 촬영 당시 수면입니다.
    실제로 이 구간 하도의 DEM 표고는 43 km 내내 4.0 m 근처로 거의 평평한데(표준편차 0.59 m),
    하상이라면 여울과 소로 훨씬 크게 흩어져야 합니다. 담수역 평균수심은 6.32 m 이므로
    하상은 그만큼 더 아래에 있습니다. 하도 밖 홍수터의 수심은 이 문제가 없습니다.<br><br>
    특히 <b>지류 골짜기 안쪽까지 물이 차 보이는 것</b>은 모든 지점에 가장 가까운 본류 수면표고를
    그대로 적용했기 때문입니다. 실제로는 합류부에서 멀어질수록 배수위 영향이 줄어들므로,
    본류에서 먼 골짜기의 침수는 과대표시입니다 —
    <b>'본류 거리' 슬라이더</b>로 표시 범위를 좁혀 확인해 보세요.`;
}


/* ---- 담수역(보 구간) 30 m 보기 ----
   전 구간은 정점 2,000만개라 90 m 로 솎아 쓴다(10d). 확대하면 지형이 90 m 계단으로 보여
   물가 선이 뭉개진다. 담수역 하나면 30 m 로도 정점이 0.4~2.7M 이라 감당된다(10f).

   구간을 바꿀 때는 페이지를 다시 연다. 장면을 살려둔 채 격자를 갈아끼우면 메시·텍스처·
   타일 캐시를 모두 정리해야 해서 실수가 끼기 쉽다 — 다시 여는 쪽이 확실하다. */
const POOL = new URLSearchParams(location.search).get("pool");
const POOL_BASE = POOL !== null && /^[0-8]$/.test(POOL) ? `pools/p${POOL}/` : "";

async function buildPoolPicker(){
  const box = el("poolPick");
  if(!box) return;
  let idx = null;
  try{
    const r = await fetch("pools/index.json", {cache:"no-store"});
    if(r.ok) idx = await r.json();
  }catch(e){ /* 고해상도 자료가 아직 없으면 전 구간만 쓴다 */ }
  if(!idx){ box.innerHTML = `<div class="ro-none">구간 자료가 아직 없습니다.</div>`; return; }

  const cur = POOL_BASE ? Number(POOL) : null;
  const mk = (label, sub, href, on) =>
    `<a class="poolbtn${on ? " on" : ""}" href="${href}"><span class="nm">${label}</span>` +
    `<span class="km2 mono">${sub}</span></a>`;
  box.innerHTML =
    mk("전 구간", `90 m · 268 km`, "?", cur === null) +
    idx.pools.map(p => mk(`담수역 ${p.pool}`,
      `30 m · ${p.s_range_km[0]}~${p.s_range_km[1]}km`,
      `?pool=${p.pool}`, cur === p.pool)).join("");
}

const PAGE = {
  base: POOL_BASE,
  chlaUrl: null,                       // 녹조는 chla/ 페이지에서 본다
  algaeUrl: null,
  buildUI(meta){
    buildUI(meta);
    buildPoolPicker();
    if(POOL_BASE){
      el("reachLabel").textContent =
        `담수역 ${POOL} (종단 ${meta.s_range_km[0]}~${meta.s_range_km[1]} km) · 지형격자 ${meta.res_m} m`;
    }
  },
  onReady(meta){
    const want = new URLSearchParams(location.search).get("s");
    select(meta.scenarios.some(x => x.key === want) ? want : meta.scenarios[0].key);
  },
};


/* ---- 실시간 수위 보기 ---- */
async function wireLive(){
  const btn = el("liveOn"), box = el("liveCtl"), info = el("liveInfo");
  if(!btn) return;
  if(!SCHAN){
    btn.disabled = true; btn.style.opacity = .45;
    info.textContent = "이 구간에는 종단거리 격자(schan.png)가 없습니다.";
    return;
  }
  btn.addEventListener("click", async ()=>{
    if(current === "live"){ select(META.scenarios[0].key); return; }   // 끄기
    try{
      if(!LIVE.ready){ info.textContent = "수위 자료 받는 중…"; await loadLive(); }
    }catch(e){ info.textContent = "수위 자료를 쓰지 못합니다: " + e.message; return; }
    const sl = el("liveSlider");
    sl.max = String(LIVE.hours.length - 1);
    sl.value = String(LIVE.idx);
    box.hidden = false;
    showLive(LIVE.idx);
  });
  // ?live=1 로 바로 켤 수 있다(화면 공유·점검용). ?lh=12 처럼 시각 색인도 줄 수 있다.
  const q = new URLSearchParams(location.search);
  if(q.has("live")){
    try{
      await loadLive();
      const h = parseInt(q.get("lh"), 10);
      el("liveSlider").max = String(LIVE.hours.length - 1);
      box.hidden = false;
      showLive(Number.isFinite(h) ? Math.max(0, Math.min(LIVE.hours.length - 1, h)) : LIVE.idx);
    }catch(e){ info.textContent = "수위 자료를 쓰지 못합니다: " + e.message; }
  }

  el("liveSlider") && el("liveSlider").addEventListener("input", e => showLive(+e.target.value));
  el("livePrev") && el("livePrev").addEventListener("click", ()=> showLive(Math.max(0, LIVE.idx - 1)));
  el("liveNext") && el("liveNext").addEventListener("click",
    ()=> showLive(Math.min(LIVE.hours.length - 1, LIVE.idx + 1)));
}

function showLive(k){
  LIVE.idx = k;
  const sl = el("liveSlider"); if(sl) sl.value = String(k);
  const r = computeLiveDepth(k);
  const info = el("liveInfo");
  if(!r){ info.textContent = `${LIVE.hours[k]} — 이 시각에는 쓸 수 있는 관측값이 없습니다.`; return; }

  DEPTHS.live = LIVE.depth;
  current = "live";
  document.querySelectorAll("#scenList button").forEach(b => b.setAttribute("aria-pressed", "false"));
  el("liveOn").setAttribute("aria-pressed", "true");
  buildWater("live");
  if(typeof invalidateBuildings === "function") invalidateBuildings();

  const used = LIVE.gauges.filter(g => g.live.series[k] !== null && g.live.series[k] !== undefined);
  el("liveArea").textContent = r.areaKm2.toFixed(1) + " km²";
  el("stArea").textContent = r.areaKm2.toFixed(1);
  el("stOff").textContent = "–";
  el("stDepth").textContent = "–";
  el("stMax").textContent = r.maxd.toFixed(2);
  info.textContent = `${LIVE.hours[k]} 기준 · 관측소 ${used.length}곳 · 침수 ${r.areaKm2.toFixed(1)} km²`
    + ` · 최대수심 ${r.maxd.toFixed(1)} m`;
}
