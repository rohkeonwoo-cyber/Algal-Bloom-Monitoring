/* ---- 녹조(Chl-a) 리본 ----
   낮은 값 파랑 → 높은 값 빨강. 수질·녹조 지도에서 널리 쓰는 방향이라 범례를 보지 않아도
   읽힌다. 다만 저농도(파랑)가 물빛과 겹칠 위험이 있어 색차를 재고 골랐다(OKLab dE).

     인접 단계 최소 dE 16.3   (이전 자홍 램프는 8.8 — 중간 단계가 서로 붙어 있었다)
     장면 요소와 최소 dE 12.3 (청록 단계 vs 회색 지형. 리본은 물 위에 놓이므로
                              실제로 겹치는 배경인 물과는 전 단계가 dE 20 이상)
     저농도색 #2f6fe0 vs 물: 얕은 물 dE 32.6, 깊은 물 dE 25.2 — 물과 헷갈리지 않는다

   데이터 값을 나타내는 면이므로 조명을 받지 않게 한다 — 음영이 끼면 같은 값이 자리에
   따라 달라 보인다.

   한계: 무지개형 램프는 값 차이를 실제보다 크거나 작게 보이게 하는 구간이 생긴다
   (청록→초록 경계에서 특히). 정확한 값 비교는 리본 색이 아니라 지점 클릭으로 읽는다. */
const CHLA_RAMP = ["#2f6fe0","#0e9aa8","#57c06b","#e8c93c","#ef7c1f","#c62317"];
const RIBBON_HALF_W = 175;   // m. 하폭 중위 310 m 와 비슷한 폭으로 둔다
const RIBBON_LIFT = 6;       // m. 수면 위로 살짝 띄워 물에 가리지 않게

let chlaMesh = null, chlaMode = "all";

function chlaColor(v, lo, hi){
  const t = Math.max(0, Math.min(1, (v - lo) / Math.max(1e-6, hi - lo)));
  const f = t * (CHLA_RAMP.length - 1);
  const i = Math.min(CHLA_RAMP.length - 2, Math.floor(f));
  return new THREE.Color(CHLA_RAMP[i]).lerp(new THREE.Color(CHLA_RAMP[i+1]), f - i);
}

// 조류경보 4지점 — 현재 등급을 색으로 띄운다. 확대해도 화면상 크기가 유지되게 배율을 맞춘다.
const ALGAE_LV_FILL = {"정상":"#7e8984","관심":"#ffd95a","경계":"#b8381a","대발생":"#6e040b"};
const algaeMarks = [];
function drawAlgaeStations(){
  if(!CHLA) return;
  const rows = (ALGAE_NOW && ALGAE_NOW.rows) ? ALGAE_NOW.rows : [];
  CHLA.stations.forEach(st=>{
    const [wx, wz] = xy5186ToWorld(st.x, st.y);
    const y = elevAtWorld(wx, wz);
    if(y === null) return;
    const r = rows.find(x => x.station === st.name);
    const lv = r && r.level ? r.level : null;
    const fill = new THREE.Color(lv ? (ALGAE_LV_FILL[lv] || "#7e8984") : "#5f7079");
    const grp = new THREE.Group();
    grp.position.set(wx, y + RIBBON_LIFT, wz);
    const head = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0),
      new THREE.MeshBasicMaterial({color: fill}));
    head.position.y = 2.4;
    grp.add(head);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.4, 6),
      new THREE.MeshBasicMaterial({color: fill}));
    stem.position.y = 1.2;
    grp.add(stem);
    grp.userData = {name: st.name, level: lv,
      cells: r && r.cell_count != null ? Math.round(r.cell_count).toLocaleString() : null,
      date: r && r.date ? r.date : null, approx: st.approx, basis: st.basis};
    group.add(grp);
    algaeMarks.push(grp);
  });
  scaleAlgae();
  el("algaeNote").textContent =
    `조류경보 ${algaeMarks.length}지점 표시 · ` +
    (ALGAE_NOW ? "현재 등급 반영" : "등급 자료 없음(침수 기능은 정상)");
}
// 넓게 볼 때는 리본이 침수 수면(최대 14 m)에 가려 안 보인다. 보는 거리에 따라
// 지면 위로 띄워, 전체 보기에서는 강 위에 떠 있는 띠로 읽히게 한다.
function liftChla(){
  if(!chlaMesh) return;
  chlaMesh.position.y = Math.max(8, Math.min(320, orbit.dist * 0.0016));
}

function scaleAlgae(){
  // 핀 전체 높이가 화면 높이의 1% 쯤 되게 맞춘다(local 단위로 약 3.4).
  // SPANX(98 km) 비례로 잡았더니 전 구간 보기에서 산만큼 커졌다.
  const k = Math.max(SPANX * 0.0012, Math.min(SPANX * 0.006, orbit.dist * 0.0030));
  for(const g of algaeMarks) g.scale.setScalar(k);
}

function buildChla(){
  if(chlaMesh){ group.remove(chlaMesh); chlaMesh.geometry.dispose(); chlaMesh.material.dispose(); chlaMesh = null; }
  if(!CHLA || chlaMode === "off") return;
  const key = chlaMode;
  const segs = CHLA.segments.map(s=>{
    const [wx, wz] = xy5186ToWorld(s.x, s.y);
    return {wx, wz, v: s[key], y: elevAtWorld(wx, wz)};
  }).filter(s => s.y !== null);
  const rng = key === "jja" ? CHLA.range_jja : CHLA.range_all;
  const [lo, hi] = rng;

  // 인접 구간이 같은 꼭짓점을 쓰도록 이등분 법선을 계산한다(굽이에서 톱니가 생기지 않게)
  const nx = new Float32Array(segs.length), nz = new Float32Array(segs.length);
  for(let i = 0; i < segs.length; i++){
    let dx, dz;
    const a = segs[Math.max(0, i-1)], b = segs[Math.min(segs.length-1, i+1)];
    dx = b.wx - a.wx; dz = b.wz - a.wz;
    const L = Math.hypot(dx, dz) || 1;
    nx[i] = -dz / L; nz[i] = dx / L;
  }
  const pos = [], col = [], idx = [];
  const vi = new Int32Array(segs.length).fill(-1);
  for(let i = 0; i < segs.length; i++){
    const s = segs[i];
    if(s.v === null || s.v === undefined) continue;
    vi[i] = pos.length / 3 / 2;
    const c = chlaColor(s.v, lo, hi);
    for(const sg of [1, -1]){
      pos.push(s.wx + nx[i]*RIBBON_HALF_W*sg, s.y + RIBBON_LIFT, s.wz + nz[i]*RIBBON_HALF_W*sg);
      col.push(c.r, c.g, c.b);
    }
  }
  for(let i = 0; i + 1 < segs.length; i++){
    if(vi[i] < 0 || vi[i+1] < 0) continue;              // 값 없는 구간은 잇지 않는다
    if(Math.hypot(segs[i+1].wx - segs[i].wx, segs[i+1].wz - segs[i].wz) > 800) continue;
    const a = vi[i]*2, b = a+1, c2 = vi[i+1]*2, d = c2+1;
    idx.push(a, c2, b, b, c2, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  chlaMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    vertexColors:true, side:THREE.DoubleSide, depthWrite:false }));
  chlaMesh.renderOrder = 2;
  group.add(chlaMesh);
  liftChla();

  el("chlaSwatches").innerHTML = `<i style="position:absolute;inset:0;background:linear-gradient(90deg,${CHLA_RAMP.join(",")})"></i>`;
  el("chlaLo").textContent = lo.toFixed(0) + "%";
  el("chlaMid").textContent = ((lo+hi)/2).toFixed(0) + "%";
  el("chlaHi").textContent = hi.toFixed(0) + "%";
}

// 지형 메시. PlaneGeometry 대신 직접 만들어 격자 간격(meshStep)을 고를 수 있게 한다 —
// 원본 30 m 격자는 정점 246만개라 약한 기기에서는 버겁다.
