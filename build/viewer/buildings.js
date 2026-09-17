
/* ---- 건물 레이어 (브이월드 2D 데이터 API) ----
   확대했을 때 도시가 서 있어야 "어디까지 잠기는가"가 읽힌다. 지형만 있으면 규모감이 없다.

   자료: LT_C_BLDGINFO — 건물 윤곽(폴리곤) + height(m) + grnd_flr(지상층수).
   EPSG:5186 으로 요청하면 그대로 5186 으로 돌려주므로 뷰어 격자와 재투영 없이 맞는다.

   **높이는 절반 이상이 추정값이다.** 표본 4,000동에서 height 가 들어 있는 건물은 20~35%
   뿐이었다. 없으면 층수 × 4.6 m(실측 중위값)로 세우고, 층수도 없으면 3.5 m 로 둔다.
   화면에도 이 사실을 적는다 — 건물 높이를 실측처럼 보이게 하면 안 된다.

   범위가 넓으면 건물이 수십만 동이라 한 번에 못 받는다. 화면이 충분히 확대됐을 때만,
   보이는 범위를 1 km 타일로 끊어 받고 타일 단위로 캐시한다(브이월드 상세영상과 같은 방식). */
const BLD = {
  // 기본으로 켠다. 화면 폭이 6 km 아래로 좁아졌을 때만 요청하므로 넓게 볼 때는 호출이 없다.
  // (항공영상도 기본 꺼짐이라 "화질이 낮다"는 인상을 줬다 — 켜야 보이는 기능은 없는 기능과 같다.)
  // ?bld=0 으로 끌 수 있다.
  on: new URLSearchParams(location.search).get("bld") !== "0", group: null, cache: new Map(), busy: false, lastSig: "",
  tile: 1000,          // m. 요청 단위
  maxTiles: 12,        // 한 번에 받을 타일 수 상한
  maxSize: 1000,       // 한 요청당 건물 수 상한(API 제한)
  minWidth: 6000,      // 화면 가로가 이보다 좁아지면 켠다(m)
  floorH: 4.6,         // m/층 — height 없는 건물의 환산 계수(실측 중위값)
  count: 0, flooded: 0, failed: new Set(),
  /* 브이월드 **데이터 API 는 등록 도메인을 강제한다**(항공영상 WMTS 는 Referer 를 안 본다 —
     둘의 동작이 다르다). 확인 결과 이 키는 배포 주소로 등록되어 있어, 로컬에서 열어도
     그 주소를 보내야 통과한다. 키가 공개돼 있으므로 이 값도 숨길 것이 없다. */
  domain: "https://rohkeonwoo-cyber.github.io",
};

/* 점검용 우회: ?bldsrc=경로 를 주면 그 파일을 대신 읽는다(브이월드 API 는 등록 주소에서만
   동작해 로컬에서 그리기 코드를 확인할 수 없기 때문). 운영에는 영향이 없다. */
function bldUrl(x0, y0, x1, y1){
  // 같은 폴더의 파일만 허용한다 — 주소로 임의의 외부 스크립트를 불러오게 두면 안 된다.
  const src = new URLSearchParams(location.search).get("bldsrc");
  if(src && /^[\w.-]+\.js$/.test(src)) return src;
  const p = new URLSearchParams({
    service:"data", version:"2.0", request:"GetFeature", format:"json",
    size:String(BLD.maxSize), page:"1", data:"LT_C_BLDGINFO",
    geomFilter:`BOX(${x0},${y0},${x1},${y1})`, crs:"EPSG:5186",
    columns:"bld_nm,height,grnd_flr,ag_geom", key:VW.key, domain:BLD.domain,
  });
  return "https://api.vworld.kr/req/data?" + p.toString();
}

/* 브이월드 데이터 API 는 **CORS 헤더를 주지 않아** fetch 로는 못 읽는다(응답은 200 인데
   브라우저가 막는다). 대신 callback 파라미터로 JSONP 를 지원하므로 <script> 로 받는다. */
let jsonpSeq = 0;
function jsonp(url){
  return new Promise((resolve, reject)=>{
    const cb = "__vwcb" + (++jsonpSeq);
    const tag = document.createElement("script");
    const clean = ()=>{ delete window[cb]; tag.remove(); clearTimeout(timer); };
    const timer = setTimeout(()=>{ clean(); reject(new Error("응답 없음")); }, 20000);
    window[cb] = v => { clean(); resolve(v); };
    tag.onerror = ()=>{ clean(); reject(new Error("요청 실패")); };
    tag.src = url + (url.includes("?") ? "&" : "?") + "callback=" + cb;
    document.head.appendChild(tag);
  });
}

function bldHeight(p){
  const h = parseFloat(p.height);
  if(h > 0) return h;
  const f = parseFloat(p.grnd_flr);
  return f > 0 ? f * BLD.floorH : 3.5;
}

/* 한 타일의 건물을 받아 하나의 메시로 만든다. 건물마다 메시를 만들면 수천 개가 되어 느리다. */
async function fetchBuildingTile(tx, ty){
  const key = `${tx},${ty}`;
  if(BLD.cache.has(key)) return BLD.cache.get(key);
  const x0 = tx * BLD.tile, y0 = ty * BLD.tile;
  let feats = [];
  try{
    const j = await jsonp(bldUrl(x0, y0, x0 + BLD.tile, y0 + BLD.tile));
    const st = j.response && j.response.status;
    if(st === "OK") feats = j.response.result.featureCollection.features || [];
    else if(st !== "NOT_FOUND") throw new Error((j.response.error || {}).text || st);
  }catch(e){
    BLD.cache.set(key, null);        // 실패한 타일은 다시 조르지 않는다
    BLD.failed.add(key);             // "자료 없음"과 "요청 실패"를 구분해 알리기 위해
    return null;
  }
  const mesh = feats.length ? buildingMesh(feats) : null;
  BLD.cache.set(key, mesh);
  return mesh;
}

function buildingMesh(feats){
  const pos = [], col = [], idx = [];
  const cGray = new THREE.Color("#c9d3d6"), cWet = new THREE.Color("#d8583f");
  let n = 0, flooded = 0;
  for(const f of feats){
   try{
    const h = bldHeight(f.properties);
    const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
    for(const poly of polys){
      const ring = poly[0];
      if(!ring || ring.length < 4) continue;
      // 5186 → 화면좌표. 바닥 높이는 건물 중심의 지형 표고를 쓴다(지형에 붙어 서게).
      let sx = 0, sy = 0;
      const pts = [];
      for(let i = 0; i < ring.length - 1; i++){
        const [wx, wz] = xy5186ToWorld(ring[i][0], ring[i][1]);
        pts.push([wx, wz]); sx += wx; sy += wz;
      }
      if(pts.length < 3) continue;
      // 윤곽의 회전 방향이 자료마다 달라 면이 뒤집힌다 — 반시계로 통일한다.
      let area2 = 0;
      for(let i = 0; i < pts.length; i++){
        const [x1, z1] = pts[i], [x2, z2] = pts[(i+1) % pts.length];
        area2 += x1 * z2 - x2 * z1;
      }
      if(area2 < 0) pts.reverse();
      const cx = sx / pts.length, cz = sy / pts.length;
      const base = elevAtWorld(cx, cz);
      if(base === null) continue;
      const g = gridAt(cx, cz);
      const D = DEPTHS[current];
      const wet = g && D ? D.v[g.r * GW + g.c] * META.depth_scale > 0.05 : false;
      if(wet) flooded++;
      n++;
      const c = wet ? cWet : cGray;
      const top = base + h;
      const b0 = pos.length / 3;
      // 옆면: 바닥·천장 정점을 번갈아 넣고 사각형 두 장씩
      for(const [px, pz] of pts){ pos.push(px, base, pz, px, top, pz); col.push(c.r,c.g,c.b, c.r,c.g,c.b); }
      for(let i = 0; i < pts.length; i++){
        const a = b0 + i*2, b = b0 + ((i+1) % pts.length)*2;
        idx.push(a, b, a+1, b, b+1, a+1);
      }
      // 지붕: 평면 삼각분할
      const shape = pts.map(([px, pz]) => new THREE.Vector2(px, pz));
      let tris = [];
      try{ tris = THREE.ShapeUtils.triangulateShape(shape, []); }catch(e){ tris = []; }
      for(const t of tris) idx.push(b0 + t[0]*2 + 1, b0 + t[2]*2 + 1, b0 + t[1]*2 + 1);
    }
   }catch(e){ /* 건물 하나가 이상해도 나머지는 세운다 */ }
  }
  if(!n) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // 양면 렌더 — 윤곽을 정리해도 자료에 자기교차 폴리곤이 섞여 있어 뒤집히는 면이 남는다.
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
    vertexColors:true, flatShading:true, side:THREE.DoubleSide}));
  m.userData = {count:n, flooded};
  return m;
}

/* 보이는 범위의 타일을 채운다. 카메라가 멈췄을 때만 부른다(상세영상과 같은 시점). */
async function refreshBuildings(){
  const st = el("bldStat");
  if(!BLD.group){ BLD.group = new THREE.Group(); group.add(BLD.group); }
  if(!BLD.on || BLD.busy) return;
  const v = viewRegion();            // {cx, cy, half} — EPSG:5186
  if(!v) return;
  if(v.half * 2 > BLD.minWidth){
    BLD.group.clear();
    if(st) st.textContent = `더 확대하면 건물이 나타납니다 (현재 폭 ${(v.half*2/1000).toFixed(1)} km)`;
    return;
  }
  BLD.busy = true;
  const tiles = [];
  for(let tx = Math.floor((v.cx - v.half) / BLD.tile); tx <= Math.floor((v.cx + v.half) / BLD.tile); tx++)
    for(let ty = Math.floor((v.cy - v.half) / BLD.tile); ty <= Math.floor((v.cy + v.half) / BLD.tile); ty++)
      tiles.push([tx, ty]);
  // 화면 중심에 가까운 타일부터 (상한에 걸리면 가장자리를 버린다)
  tiles.sort((a, b) =>
    Math.hypot(a[0]*BLD.tile - v.cx, a[1]*BLD.tile - v.cy) -
    Math.hypot(b[0]*BLD.tile - v.cx, b[1]*BLD.tile - v.cy));
  const use = tiles.slice(0, BLD.maxTiles);
  if(st) st.textContent = `건물 받는 중… (타일 ${use.length}개)`;

  BLD.group.clear();
  let cnt = 0, wet = 0, fail = 0;
  for(const [tx, ty] of use){
    const m = await fetchBuildingTile(tx, ty);
    if(m === null && BLD.failed.has(`${tx},${ty}`)) fail++;
    if(!m) continue;
    BLD.group.add(m);
    cnt += m.userData.count; wet += m.userData.flooded;
  }
  BLD.count = cnt; BLD.flooded = wet;
  if(st) st.textContent = cnt
    ? `건물 ${cnt.toLocaleString()}동`
      + (DEPTHS[current] ? ` · 잠김 ${wet.toLocaleString()}동` : "")
      + (tiles.length > use.length ? ` (가운데 ${use.length}/${tiles.length} 타일만)` : "")
    : (fail === use.length
        ? "건물을 받지 못했습니다 — 브이월드 데이터 API 는 등록 주소에서만 동작합니다"
          + "(로컬에서 연 경우 정상입니다)."
        : "이 범위에는 건물 자료가 없습니다.");
  BLD.busy = false;
}

/* 카메라가 멈춘 뒤 한 번만 — 움직이는 동안 요청하지 않는다. */
let bldTimer = null;
function scheduleBuildings(){
  if(!BLD.on) return;
  clearTimeout(bldTimer);
  bldTimer = setTimeout(()=> refreshBuildings().catch(e=>{
    const st = el("bldStat"); if(st) st.textContent = "건물을 받지 못했습니다: " + e.message;
    BLD.busy = false;
  }), 500);
}

/* 시나리오가 바뀌면 "잠김" 판정이 달라진다 — 색을 다시 칠해야 하므로 캐시를 버린다. */
function invalidateBuildings(){
  BLD.failed.clear();
  BLD.cache.forEach(m => { if(m){ m.geometry.dispose(); m.material.dispose(); } });
  BLD.cache.clear();
  if(BLD.group) BLD.group.clear();
  if(BLD.on) refreshBuildings();
}

function wireBuildings(){
  const btn = el("bldOn"), st = el("bldStat");
  if(!btn) return;
  if(!VW.key){
    btn.disabled = true; btn.style.opacity = .45;
    st.textContent = "브이월드 인증키가 없어 건물을 받을 수 없습니다.";
    return;
  }
  btn.setAttribute("aria-pressed", String(BLD.on));
  btn.style.background = BLD.on ? "var(--accent-soft)" : "var(--surface-2)";
  btn.style.borderColor = BLD.on ? "var(--accent)" : "var(--border)";
  st.textContent = BLD.on ? "켜짐 — 확대하면 건물이 섭니다." : "꺼져 있음 — 켜면 확대할 때 건물이 섭니다.";
  btn.addEventListener("click", ()=>{
    BLD.on = !BLD.on;
    btn.setAttribute("aria-pressed", String(BLD.on));
    btn.style.background = BLD.on ? "var(--accent-soft)" : "var(--surface-2)";
    btn.style.borderColor = BLD.on ? "var(--accent)" : "var(--border)";
    if(BLD.on) refreshBuildings();
    else { if(BLD.group) BLD.group.clear(); st.textContent = "꺼짐"; }
  });
}
