const SKY_LOW = 0x9fb6c4, SKY_HIGH = 0x2c4a63;   // 지평선(밝음) → 천정(어두움)
// 얕은 물은 바닥이 비치고 깊을수록 물빛에 가려진다 — 실제 물의 감쇠(Beer-Lambert)와 같은 꼴.
// 균일 투명도로는 "얼마나 찼는지"가 안 읽혀서 불투명도를 수심의 함수로 준다.
const WATER_K = 0.45;   // 1/m. 1 m 에서 36%, 3 m 에서 74%, 8 m 에서 97% 가려짐
// 셰이더와 같은 식으로 범례 색을 만든다 — 범례와 화면이 어긋나지 않게 한 곳에서 계산한다.
function waterCss(depth, pct){
  const a = 1 - Math.exp(-WATER_K * depth);
  const sh = [163, 219, 242], dp = [13, 48, 107];
  const c = sh.map((v, i) => Math.round(v + (dp[i] - v) * Math.min(1, Math.max(0, a))));
  const alpha = Math.min(1, a * 0.90 + 0.08);
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha.toFixed(3)}) ${pct.toFixed(0)}%`;
}

function makeWaterMaterial(){
  return new THREE.ShaderMaterial({
    transparent:true, depthWrite:false, side:THREE.DoubleSide,
    uniforms:{ uMul:{value:waterOpacity}, uK:{value:WATER_K},
               uFogColor:{value:new THREE.Color(SKY_LOW)},
               uFogNear:{value:SPANX * 0.8}, uFogFar:{value:SPANX * 3.0} },
    vertexShader:`
      attribute float aDepth;
      varying float vDepth;
      varying vec3 vNormalW;
      varying float vDist;
      void main(){
        vDepth = aDepth;
        vNormalW = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader:`
      uniform float uMul; uniform float uK;
      uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar;
      varying float vDepth;
      varying vec3 vNormalW;
      varying float vDist;
      void main(){
        float a = 1.0 - exp(-uK * vDepth);            // 수심이 깊을수록 1 에 수렴
        vec3 shallow = vec3(0.64, 0.86, 0.95);
        vec3 deep    = vec3(0.05, 0.19, 0.42);
        vec3 col = mix(shallow, deep, clamp(a, 0.0, 1.0));
        // 수면이 기울어 보이는 곳에 약한 하이라이트 — 물이라는 느낌만 준다
        col += 0.10 * pow(max(vNormalW.z, 0.0), 3.0);
        float alpha = clamp(a * 0.90 + 0.08, 0.0, 1.0) * uMul;
        float f = smoothstep(uFogNear, uFogFar, vDist);
        gl_FragColor = vec4(mix(col, uFogColor, f), alpha * (1.0 - f * 0.7));
      }`,
  });
}

const el = id => document.getElementById(id);
const loadBar = el("loadBar"), loadMsg = el("loadMsg");
let done = 0, total = 1;
function step(msg){
  done++; loadBar.style.width = Math.min(100, 100*done/total) + "%";
  if(msg) loadMsg.textContent = msg;
}
function fail(msg){
  el("loading").innerHTML = `<p class="err">${msg}</p>`;
}

if(!window.THREE){
  fail("3D 라이브러리(three.js)를 불러오지 못했습니다. 네트워크를 확인하고 새로고침해 주세요.");
  return;
}

// ---------- 자료 읽기 ----------
// PNG 는 16비트 값을 R(상위)·G(하위) 두 채널에 나눠 담았다 —
// canvas 의 getImageData 가 8비트만 주기 때문(10d_웹출력.py save_u16 참조).
function loadImage(src){
  return new Promise((res, rej)=>{
    const im = new Image();
    im.onload = ()=> res(im);
    im.onerror = ()=> rej(new Error(src));
    im.src = src;
  });
}
function decodeRGB16(img){
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d", {willReadFrequently:true});
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const out = new Uint16Array(c.width * c.height);
  for(let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (d[j] << 8) | d[j+1];
  return {w:c.width, h:c.height, v:out};
}

let META, TERR, DIST = null, SCHAN = null, CHLA = null, ALGAE_NOW = null, DEPTHS = {}, scene, camera, renderer, terrainMesh, terrainMat, waterMesh, group;
let vex = 3, waterOpacity = 1.0, current = null, distLimit = Infinity;
let GW = 0, GH = 0, RES = 0, SPANX = 0, SPANZ = 0, meshStep = 1;

/* 페이지가 채워 넣는 부분(PAGE) — 침수와 녹조가 이 핵심을 공유하고 각자 UI 만 얹는다.
   PAGE = { base, chlaUrl, algaeUrl, buildUI(meta), onReady(meta) }
   base 를 바꾸면 같은 코드로 다른 자료(예: 담수역 30 m)를 띄운다. */
async function boot(){
  const B = (PAGE && PAGE.base) || "";
  // 주소의 파라미터는 **먼저** 읽어 둔다. 페이지가 history.replaceState 로 주소를 고쳐 쓰면
  // 그 뒤에는 읽을 수 없다(실제로 침수 페이지의 시나리오 선택이 ?s= 만 남기고 지웠다).
  const q = new URLSearchParams(location.search);
  let meta;
  try{
    const r = await fetch(B + "meta.json", {cache:"no-store"});
    if(!r.ok) throw new Error("meta.json " + r.status);
    meta = await r.json();
  }catch(e){
    fail("자료를 불러오지 못했습니다 (" + e.message + ").<br>이 페이지는 웹주소로 열어야 합니다 — 파일로 직접 열면 자료를 읽을 수 없습니다.");
    return;
  }
  META = meta;
  total = 2 + meta.scenarios.length + (meta.texture ? 1 : 0);

  let terrainImg, texImg = null;
  try{
    terrainImg = await loadImage(B + "terrain.png"); step("지형 격자 해석 중…");
    if(meta.texture){ texImg = await loadImage(B + meta.texture.file); step("위성영상 적용 중…"); }
    if(meta.dist_file){ DIST = decodeRGB16(await loadImage(B + meta.dist_file)); }
    // 격자별 '가장 가까운 본류 지점의 종단거리' — 실시간 수위 계산에 쓴다(10i).
    // 없으면 실시간 기능만 꺼지고 나머지는 그대로 돈다.
    try{ SCHAN = decodeRGB16(await loadImage(B + "schan.png")); }catch(e){ SCHAN = null; }
    // 부가 자료는 실패해도 본 기능은 그대로 쓸 수 있어야 한다
    if(PAGE.chlaUrl){
      try{
        const r = await fetch(PAGE.chlaUrl, {cache:"no-store"});
        if(r.ok) CHLA = await r.json();
      }catch(e){ CHLA = null; }
    }
    if(PAGE.algaeUrl){
      try{
        const r = await fetch(PAGE.algaeUrl, {cache:"no-store"});
        if(r.ok) ALGAE_NOW = await r.json();
      }catch(e){ ALGAE_NOW = null; }
    }
    for(const s of meta.scenarios){
      DEPTHS[s.key] = decodeRGB16(await loadImage(B + s.file));
      step(`침수 시나리오 ${s.label} 읽는 중…`);
    }
  }catch(e){
    fail("자료 파일을 불러오지 못했습니다: " + e.message);
    return;
  }
  TERR = decodeRGB16(terrainImg);
  step("3차원 지형 만드는 중…");

  PAGE.buildUI(meta);
  buildScene(meta, texImg);
  PAGE.onReady(meta);

  /* 링크로 특정 지점·상태를 열 수 있게 한다 — 화면을 공유하거나 점검할 때 쓴다.
       ?at=5186x,5186y   그 지점으로 이동      ?z=0.05   확대 정도(화면 폭 비율)
       ?bld=1            건물 레이어 켜기      ?vw=1     항공영상 켜기            */
  if(q.has("at")){
    const [ax, ay] = q.get("at").split(",").map(Number);
    const c = Math.round((ax - X5186_0) / RES), r = Math.round((Y5186_0 - ay) / RES);
    if(c >= 0 && r >= 0 && c < GW && r < GH){
      orbit.target.set(-SPANX/2 + c*RES, elevAt(r*GW + c) * vex, -SPANZ/2 + r*RES);
      orbit.dist = SPANX * (parseFloat(q.get("z")) || 0.05);
      applyCamera();
    }
  }
  if(VW.on && VW.key){ VW.lastSig = ""; refreshDetail().catch(e=>{
    const st = el("vwStat"); if(st) st.textContent = "항공영상을 받지 못했습니다: " + e.message;
    VW.busy = false;
  }); }
  if(typeof BLD === "object" && BLD.on && VW.key){
    refreshBuildings().catch(e=>{
      const st = el("bldStat");
      if(st) st.textContent = "건물 처리 중 오류: " + e.message;
    });
  }
  el("loading").remove();
  animate();
}

// ---------- 장면 ----------
function elevAt(i){ return TERR.v[i] * META.elev_scale + META.elev_offset_m; }

/* 5186 좌표 ↔ 화면좌표. 녹조 리본·건물 등 지형 위에 얹는 모든 레이어가 쓴다.
   (녹조 모듈에만 있어서 침수 페이지의 건물이 전부 조용히 걸러지던 적이 있다.) */
function xy5186ToWorld(x, y){
  return [x - X5186_0 - SPANX/2, (Y5186_0 - y) - SPANZ/2];
}
function elevAtWorld(wx, wz){
  const c = Math.round((wx + SPANX/2) / RES), r = Math.round((wz + SPANZ/2) / RES);
  if(c < 0 || r < 0 || c >= GW || r >= GH) return null;
  return elevRender(r * GW + c);
}

// 렌더 전용 평활 표고. 30 m 격자를 그대로 세우면 능선이 계단처럼 꺾여 보인다.
// 3×3 이항 커널 한 번으로 표본화 계단만 눌러준다(지형을 만들어내지 않는 최소한).
// 수심·표고 판독과 침수 계산에는 원본 elevAt() 을 그대로 쓴다.
let ELEV_SMOOTH = null;
function buildSmoothElev(){
  const n = GW * GH, out = new Float32Array(n), src = TERR.v;
  const sc = META.elev_scale, off = META.elev_offset_m;
  const tmp = new Float32Array(n);
  for(let r = 0; r < GH; r++){            // 가로 방향 1-2-1
    const o = r * GW;
    for(let c = 0; c < GW; c++){
      const a = src[o + Math.max(0, c-1)], b = src[o + c], d = src[o + Math.min(GW-1, c+1)];
      tmp[o + c] = (a + 2*b + d) * 0.25;
    }
  }
  for(let c = 0; c < GW; c++){            // 세로 방향 1-2-1
    for(let r = 0; r < GH; r++){
      const a = tmp[Math.max(0, r-1)*GW + c], b = tmp[r*GW + c],
            d = tmp[Math.min(GH-1, r+1)*GW + c];
      out[r*GW + c] = (a + 2*b + d) * 0.25 * sc + off;
    }
  }
  ELEV_SMOOTH = out;
}
function elevRender(i){ return ELEV_SMOOTH ? ELEV_SMOOTH[i] : elevAt(i); }

function buildScene(meta, texImg){
  const {w, h} = TERR;
  const res = meta.res_m;
  const spanX = (w - 1) * res, spanZ = (h - 1) * res;
  GW = w; GH = h; RES = res; SPANX = spanX; SPANZ = spanZ;
  // meta.bounds_5186 은 래스터 외곽이고 정점은 화소 중심이므로 반 화소 안쪽이다
  X5186_0 = meta.bounds_5186[0] + res/2;
  Y5186_0 = meta.bounds_5186[3] - res/2;
  // 246만 정점을 모든 기기가 감당하지는 못한다. 화면이 좁으면 절반 밀도로 시작한다.
  meshStep = (innerWidth < 900 || (navigator.deviceMemory || 8) < 4) ? 2 : 1;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY_LOW);
  // 하늘 돔 — 배경이 단색이면 지형이 오려 붙인 것처럼 뜬다. 지평선 쪽을 밝게 둔다.
  const skyGeo = new THREE.SphereGeometry(Math.max(spanX, spanZ) * 4, 32, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms:{ uLow:{value:new THREE.Color(SKY_LOW)}, uHigh:{value:new THREE.Color(SKY_HIGH)} },
    vertexShader:`varying vec3 vP; void main(){ vP = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader:`uniform vec3 uLow; uniform vec3 uHigh; varying vec3 vP;
      void main(){ float h = clamp(normalize(vP).y * 1.6 + 0.15, 0.0, 1.0);
        gl_FragColor = vec4(mix(uLow, uHigh, h), 1.0); }`,
  });
  scene.add(new THREE.Mesh(skyGeo, skyMat));

  // 근접면 2 m — 건물 옆까지 내려가도 앞이 잘리지 않게. 원거리(수십 km)와 함께 쓰려면
  // 깊이 정밀도가 부족해 z-파이팅이 생기므로 로그 깊이버퍼를 켠다.
  camera = new THREE.PerspectiveCamera(46, innerWidth/innerHeight, 2, spanX * 6);
  renderer = new THREE.WebGLRenderer({antialias:true, logarithmicDepthBuffer:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  el("stage").appendChild(renderer.domElement);
  // 예: 최대 텍스처 8192 → 32×32 타일(8192²)까지. 상한을 1024장으로 둔다(요청 수 보호).
  const maxTex = Math.min(renderer.capabilities.maxTextureSize || 4096, 8192);
  VW.maxTiles = Math.min(1024, Math.pow(Math.floor(maxTex / VW.tileSize), 2));

  scene.add(new THREE.AmbientLight(0xffffff, 0.62));
  const sun = new THREE.DirectionalLight(0xfff2e0, 0.85);
  sun.position.set(-1, 1.6, 0.7).multiplyScalar(spanX);
  scene.add(sun);

  group = new THREE.Group();
  scene.add(group);

  let baseTex = null;
  if(texImg){
    baseTex = new THREE.Texture(texImg);
    baseTex.needsUpdate = true;
    baseTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    baseTex.minFilter = THREE.LinearMipmapLinearFilter;
    baseTex.generateMipmaps = true;
  }
  // 지형 재질을 직접 쓰는 이유: 넓게 보는 배경(Sentinel-2)과 확대했을 때만 받아오는
  // 상세 항공영상(브이월드)을 한 면에 합성해야 하는데, 표준 재질로는 두 텍스처를
  // 서로 다른 좌표계(격자 UV / Web Mercator)로 섞을 수 없다.
  terrainMat = new THREE.ShaderMaterial({
    uniforms:{
      uBase:{value: baseTex},
      uDetail:{value: null},
      uRect:{value: new THREE.Vector4(0, 0, 1, 1)},   // 상세영상이 덮는 정규 메르카토르 범위
      uHasDetail:{value: 0},
      uHasBase:{value: baseTex ? 1 : 0},
      uVex:{value: vex},
      uLightDir:{value: new THREE.Vector3(-1, 1.6, 0.7).normalize()},
      uSky:{value: new THREE.Color(0xbcd2e0)},      // 위에서 오는 하늘빛
      uGround:{value: new THREE.Color(0x6b6152)},   // 아래에서 되받는 땅빛
      uFogColor:{value: new THREE.Color(SKY_LOW)},
      uFogNear:{value: spanX * 0.8},
      uFogFar:{value: spanX * 3.0},
    },
    vertexShader:`
      attribute vec2 aMerc;
      uniform float uVex;
      varying vec2 vUv; varying vec2 vMerc; varying vec3 vNw; varying float vDist;
      void main(){
        vUv = uv; vMerc = aMerc;
        // 정점은 과장 전 표고로 놓고 그룹 스케일(0,vex,0)로 늘린다 →
        // 법선은 스케일의 역수를 곱해야 맞다(diag(1,1/vex,1)).
        vNw = normalize(vec3(normal.x, normal.y / uVex, normal.z));
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader:`
      uniform sampler2D uBase; uniform sampler2D uDetail;
      uniform vec4 uRect; uniform float uHasDetail; uniform float uHasBase;
      uniform vec3 uLightDir; uniform vec3 uSky; uniform vec3 uGround;
      uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar;
      varying vec2 vUv; varying vec2 vMerc; varying vec3 vNw; varying float vDist;
      void main(){
        vec3 c = uHasBase > 0.5 ? texture2D(uBase, vUv).rgb : vec3(0.36, 0.42, 0.38);
        if(uHasDetail > 0.5){
          vec2 d = (vMerc - uRect.xy) / (uRect.zw - uRect.xy);
          if(d.x > 0.0 && d.x < 1.0 && d.y > 0.0 && d.y < 1.0){
            float e = min(min(d.x, 1.0 - d.x), min(d.y, 1.0 - d.y));
            c = mix(c, texture2D(uDetail, d).rgb, smoothstep(0.0, 0.02, e));
          }
        }
        vec3 n = normalize(vNw);
        // 단일 환경광 대신 반구광: 위는 하늘빛, 아래는 땅에서 되받는 빛.
        // 평지와 사면의 색이 달라져 지형이 평평한 판처럼 보이지 않는다.
        vec3 amb = mix(uGround, uSky, 0.5 + 0.5 * n.y) * 0.74;
        float diff = max(dot(n, uLightDir), 0.0);
        // 경사가 급할수록 살짝 어둡게 — 골짜기에 그늘이 지는 느낌(그림자 계산 없이)
        float ao = mix(0.88, 1.0, smoothstep(0.25, 0.95, n.y));
        vec3 lit = c * (amb + vec3(0.86) * diff) * ao;
        // 먼 곳은 대기에 잠기게 — 지형 끝이 칼로 자른 듯 끊기는 것을 없앤다
        float f = smoothstep(uFogNear, uFogFar, vDist);
        gl_FragColor = vec4(mix(lit, uFogColor, f), 1.0);
      }`,
  });
  buildTerrain();

  group.scale.y = vex;
  frameCamera(spanX, spanZ);
  addEventListener("resize", ()=>{
    camera.aspect = innerWidth/innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  setupControls(spanX);
}


/* =======================================================================
   브이월드 항공영상 상세 텍스처
   배경은 Sentinel-2(10 m) 한 장을 그대로 쓰고, 확대했을 때만 보이는 범위에
   해당하는 브이월드 타일(최대 0.24 m)을 받아 그 부분만 덮어쓴다.
   구간 전체를 0.24 m 로 담으면 180,736×195,584 화소(175 GB)라 GPU 한계(16,384)를
   한참 넘기 때문에, "한 장을 유지하되 보는 범위만 갈아끼우는" 방식을 쓴다.
   ======================================================================= */
const VW = {
  key: (typeof window.VWORLD_KEY === "string" ? window.VWORLD_KEY.trim() : ""),
  minZ: 14, maxZ: 19, tileSize: 256,
  // 타일 수 상한은 그래픽카드의 최대 텍스처 크기에 맞춰 정한다(buildScene 에서 채운다).
  // 고정 196장(3584²)으로 두면 8K 텍스처를 지원하는 기기에서도 흐릿하게 쓰게 된다.
  maxTiles: 196,
  // 기본으로 켠다. 꺼 두면 처음 열었을 때 30 m 위성 텍스처만 보여 "화질이 낮다"고 느낀다.
  // ?vw=0 으로 끌 수 있다.
  on: new URLSearchParams(location.search).get("vw") !== "0",
  busy: false, timer: null, lastSig: "",
  cache: new Map(),          // 같은 세션에서 본 타일은 다시 요청하지 않는다
};

// EPSG:5186 → WGS84 역투영. pyproj 와 최대 0.022 mm 일치 확인(build/좌표역투영검증.py).
const TMI = (()=>{
  const A = 6378137.0, FL = 1/298.257222101;
  const E2 = 2*FL - FL*FL, EP2 = E2/(1-E2);
  const E1 = (1 - Math.sqrt(1-E2)) / (1 + Math.sqrt(1-E2));
  const LAT0 = 38*Math.PI/180, LON0 = 127*Math.PI/180;
  const X0 = 200000, Y0 = 600000;
  function M(phi){
    return A*((1 - E2/4 - 3*E2**2/64 - 5*E2**3/256)*phi
            - (3*E2/8 + 3*E2**2/32 + 45*E2**3/1024)*Math.sin(2*phi)
            + (15*E2**2/256 + 45*E2**3/1024)*Math.sin(4*phi)
            - (35*E2**3/3072)*Math.sin(6*phi));
  }
  const M0 = M(LAT0);
  const MU_D = A*(1 - E2/4 - 3*E2**2/64 - 5*E2**3/256);
  return { A, E2, EP2, E1, LON0, X0, Y0, M0, MU_D };
})();

// 한 행(같은 y)에 대해 위도 관련 항을 한 번만 계산하고, 열마다 x 만 넣는 클로저를 준다.
function tmInverseRow(y){
  const {A, E2, EP2, E1, LON0, X0, Y0, M0, MU_D} = TMI;
  const mu = (M0 + (y - Y0)) / MU_D;
  const phi1 = mu
    + (3*E1/2 - 27*E1**3/32)*Math.sin(2*mu)
    + (21*E1**2/16 - 55*E1**4/32)*Math.sin(4*mu)
    + (151*E1**3/96)*Math.sin(6*mu)
    + (1097*E1**4/512)*Math.sin(8*mu);
  const cp = Math.cos(phi1), sp = Math.sin(phi1), tp = Math.tan(phi1);
  const C1 = EP2*cp*cp, T1 = tp*tp;
  const N1 = A/Math.sqrt(1 - E2*sp*sp);
  const R1 = A*(1 - E2)/Math.pow(1 - E2*sp*sp, 1.5);
  const k = N1*tp/R1;
  const RAD = 180/Math.PI;
  return function(x){
    const D = (x - X0)/N1, D2 = D*D;
    const lat = phi1 - k*(D2/2
      - (5 + 3*T1 + 10*C1 - 4*C1*C1 - 9*EP2)*D2*D2/24
      + (61 + 90*T1 + 298*C1 + 45*T1*T1 - 252*EP2 - 3*C1*C1)*D2*D2*D2/720);
    const lon = LON0 + (D
      - (1 + 2*T1 + C1)*D2*D/6
      + (5 - 2*C1 + 28*T1 - 3*C1*C1 + 8*EP2 + 24*T1*T1)*D2*D2*D/120)/cp;
    return [lon*RAD, lat*RAD];
  };
}
function mercY(latDeg){
  const lr = latDeg*Math.PI/180;
  return (1 - Math.log(Math.tan(lr) + 1/Math.cos(lr))/Math.PI)/2;
}
let X5186_0 = 0, Y5186_0 = 0;    // 정점(0,0) 의 5186 좌표(화소 중심)

function tileUrl(z, x, y){
  return `https://api.vworld.kr/req/wmts/1.0.0/${VW.key}/Satellite/${z}/${y}/${x}.jpeg`;
}
function loadTile(z, x, y){
  const k = `${z}/${x}/${y}`;
  if(VW.cache.has(k)) return VW.cache.get(k);
  const pr = new Promise(res=>{
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = ()=> res(im);
    im.onerror = ()=> res(null);      // 없는 타일은 건너뛴다(바다·경계 밖)
    im.src = tileUrl(z, x, y);
  });
  VW.cache.set(k, pr);
  if(VW.cache.size > 1200) VW.cache.delete(VW.cache.keys().next().value);
  return pr;
}

function viewRegion(){
  // 보고 있는 지점(orbit.target)을 중심으로, 확대 정도에 비례한 정사각 범위를 잡는다.
  const half = Math.max(120, Math.min(orbit.dist * 0.5, 26000));
  // 정점 c 는 world x = -SPANX/2 + c·RES, 5186 x = X5186_0 + c·RES 이므로
  // 5186 x = X5186_0 + (world x + SPANX/2). z 축은 남쪽이 +이므로 부호가 반대.
  const cx = X5186_0 + orbit.target.x + SPANX/2;
  const cy = Y5186_0 - (orbit.target.z + SPANZ/2);
  return {cx, cy, half};
}

async function refreshDetail(){
  const st = el("vwStat");
  if(!VW.on || !VW.key){ return; }
  const {cx, cy, half} = viewRegion();
  const row = tmInverseRow(cy);
  const [lonC, latC] = row(cx);
  const cosLat = Math.cos(latC*Math.PI/180);

  // 줌은 "화면 화소보다 약간 더 촘촘한 수준"으로 고른다. 더 높은 줌을 써도 화면에서
  // 구분되지 않는데 타일 수만 네 배가 되므로, 호출을 낭비하지 않는 기준이 이쪽이다.
  const targetMpp = (2*half) / (Math.max(innerWidth, 800) * 1.3);
  let z = 0, x0 = 0, y0 = 0, nx = 0, ny = 0;
  for(let zz = VW.minZ; zz <= VW.maxZ; zz++){
    const res = 156543.03392/Math.pow(2, zz)*cosLat;
    if(res > targetMpp && zz < VW.maxZ) continue;    // 아직 화면보다 거칠면 더 확대
    const n = Math.pow(2, zz);
    const mx0 = (lonC + 180)/360 - (half/(cosLat*111320))/360;
    const mx1 = (lonC + 180)/360 + (half/(cosLat*111320))/360;
    const my0 = mercY(latC + half/110540);
    const my1 = mercY(latC - half/110540);
    const tx0 = Math.floor(mx0*n), tx1 = Math.floor(mx1*n);
    const ty0 = Math.floor(my0*n), ty1 = Math.floor(my1*n);
    const w = tx1 - tx0 + 1, h = ty1 - ty0 + 1;
    if(w*h <= VW.maxTiles){ z = zz; x0 = tx0; y0 = ty0; nx = w; ny = h; break; }
  }
  // 화면보다 한 단계만 고운 줌에서 멈추지 말고, 타일 예산이 남으면 더 선명한 줌으로 올린다.
  // (예산은 그래픽카드 최대 텍스처 크기에서 정해진다 — buildScene 참조)
  while(z && z < VW.maxZ){
    const n = Math.pow(2, z + 1);
    const mx0 = (lonC + 180)/360 - (half/(cosLat*111320))/360;
    const mx1 = (lonC + 180)/360 + (half/(cosLat*111320))/360;
    const my0 = mercY(latC + half/110540), my1 = mercY(latC - half/110540);
    const tx0 = Math.floor(mx0*n), tx1 = Math.floor(mx1*n);
    const ty0 = Math.floor(my0*n), ty1 = Math.floor(my1*n);
    const w = tx1 - tx0 + 1, h = ty1 - ty0 + 1;
    if(w*h > VW.maxTiles) break;
    z += 1; x0 = tx0; y0 = ty0; nx = w; ny = h;
  }
  if(!z){ st.textContent = "범위가 너무 넓어 항공영상을 쓰지 않습니다(배경 위성 유지)"; return; }

  const sig = `${z}/${x0}/${y0}/${nx}/${ny}`;
  if(sig === VW.lastSig || VW.busy) return;
  VW.busy = true;
  const mpp = 156543.03392/Math.pow(2, z)*cosLat;
  st.textContent = `타일 ${nx*ny}장 받는 중… (줌 ${z}, ${mpp.toFixed(2)} m/화소)`;

  const cv = document.createElement("canvas");
  cv.width = nx*VW.tileSize; cv.height = ny*VW.tileSize;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#7d8f64"; ctx.fillRect(0, 0, cv.width, cv.height);
  const jobs = [];
  for(let j = 0; j < ny; j++)
    for(let i = 0; i < nx; i++)
      jobs.push(loadTile(z, x0+i, y0+j).then(im=>{
        if(im) ctx.drawImage(im, i*VW.tileSize, j*VW.tileSize);
      }));
  await Promise.all(jobs);

  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false;                 // 메르카토르 y 와 캔버스 행 방향이 같다
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  const prev = terrainMat.uniforms.uDetail.value;
  terrainMat.uniforms.uDetail.value = tex;
  const n = Math.pow(2, z);
  terrainMat.uniforms.uRect.value.set(x0/n, y0/n, (x0+nx)/n, (y0+ny)/n);
  terrainMat.uniforms.uHasDetail.value = 1;
  if(prev) prev.dispose();
  VW.lastSig = sig; VW.busy = false;
  // 화면 1화소가 몇 m 인지와 영상 원본 해상도를 같이 보여준다. 원본보다 더 확대하면
  // 아무리 당겨도 선명해지지 않는다 — 코드 한계가 아니라 자료 한계임을 알리는 것이다.
  const screenMpp = (2 * half) / Math.max(innerWidth, 800);
  const over = screenMpp < mpp * 0.9
    ? ` · 화면 ${screenMpp.toFixed(2)} m/화소 — 원본보다 확대해 흐려집니다`
    : "";
  st.textContent = `브이월드 줌 ${z} · ${mpp.toFixed(2)} m/화소 · 타일 ${nx*ny}장${over}`
    + ` (캐시 ${VW.cache.size})`;
}

function scheduleDetail(){
  if(!VW.on) return;
  clearTimeout(VW.timer);
  // 움직이는 동안 요청하지 않고, 멈춘 뒤 한 번만 받는다(호출 수 절약)
  VW.timer = setTimeout(()=> refreshDetail().catch(e=>{
    el("vwStat").textContent = "항공영상을 받지 못했습니다: " + e.message;
    VW.busy = false;
  }), 450);
}

function buildTerrain(){
  if(!ELEV_SMOOTH) buildSmoothElev();
  if(terrainMesh){ group.remove(terrainMesh); terrainMesh.geometry.dispose(); }
  const st = meshStep;
  const nx = Math.floor((GW - 1) / st) + 1, ny = Math.floor((GH - 1) / st) + 1;
  const pos = new Float32Array(nx * ny * 3);
  const uv = new Float32Array(nx * ny * 2);
  const merc = new Float32Array(nx * ny * 2);   // 정규 Web Mercator — 항공영상 합성용
  const x0 = -SPANX / 2, z0 = -SPANZ / 2;
  for(let j = 0; j < ny; j++){
    const r = Math.min(GH - 1, j * st);
    const row = tmInverseRow(Y5186_0 - r * RES);   // 같은 행은 위도 계산을 한 번만
    for(let i = 0; i < nx; i++){
      const c = Math.min(GW - 1, i * st);
      const k = j * nx + i;
      pos[k*3]   = x0 + c * RES;
      pos[k*3+1] = elevRender(r * GW + c);
      pos[k*3+2] = z0 + r * RES;
      uv[k*2]   = c / (GW - 1);
      uv[k*2+1] = 1 - r / (GH - 1);
      const ll = row(X5186_0 + c * RES);
      merc[k*2]   = (ll[0] + 180) / 360;
      merc[k*2+1] = mercY(ll[1]);
    }
  }
  const idx = new (nx*ny > 65535 ? Uint32Array : Uint16Array)((nx-1)*(ny-1)*6);
  let q = 0;
  for(let j = 0; j < ny - 1; j++){
    for(let i = 0; i < nx - 1; i++){
      const a = j*nx + i, b = a + 1, c2 = a + nx, d = c2 + 1;
      idx[q++] = a; idx[q++] = c2; idx[q++] = b;
      idx[q++] = b; idx[q++] = c2; idx[q++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setAttribute("aMerc", new THREE.BufferAttribute(merc, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  terrainMesh = new THREE.Mesh(g, terrainMat);
  group.add(terrainMesh);
  el("vertCount").textContent = (nx*ny/1e4).toFixed(0) + "만";
}

// 침수 메시: 수심이 있는 화소로 이루어진 사각형만 골라 만든다.
// 전체 격자를 덮고 투명도로 지우면 가장자리가 지저분해진다.
function buildWater(key){
  if(waterMesh){ group.remove(waterMesh); waterMesh.geometry.dispose(); waterMesh.material.dispose(); }
  const D = DEPTHS[key], {w, h} = TERR, res = META.res_m;
  const spanX = (w - 1) * res, spanZ = (h - 1) * res;
  const x0 = -spanX / 2, z0 = -spanZ / 2;
  const scale = META.depth_scale;

  let maxD = 0;
  for(let i = 0; i < D.v.length; i++) if(D.v[i] > maxD) maxD = D.v[i];
  maxD *= scale;

  const idxOf = new Int32Array(w * h).fill(-1);
  const verts = [], depths = [], tris = [];
  const st = meshStep;
  for(let r = 0; r < h; r += st){
    for(let c = 0; c < w; c += st){
      const i = r * w + c;
      const d = D.v[i] * scale;
      if(d <= 0) continue;
      // 본류에서 먼 지류 골짜기는 배수위 감쇠를 반영하지 않아 과대표시된다.
      // 임의 감쇠 모형을 끼워넣는 대신, 보이는 범위를 직접 자를 수 있게 한다.
      if(DIST && DIST.v[i] * (META.dist_scale || 1) > distLimit) continue;
      idxOf[i] = verts.length / 3;
      verts.push(x0 + c * res, elevRender(i) + d, z0 + r * res);
      depths.push(d);
    }
  }
  for(let r = 0; r + st < h; r += st){
    for(let c = 0; c + st < w; c += st){
      const a = idxOf[r*w + c], b = idxOf[r*w + c + st];
      const cc = idxOf[(r+st)*w + c], dd = idxOf[(r+st)*w + c + st];
      if(a < 0 || b < 0 || cc < 0 || dd < 0) continue;   // 네 꼭짓점이 모두 침수일 때만
      tris.push(a, cc, b, b, cc, dd);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute("aDepth", new THREE.Float32BufferAttribute(depths, 1));
  g.setIndex(tris);
  g.computeVertexNormals();
  waterMesh = new THREE.Mesh(g, makeWaterMaterial());
  waterMesh.renderOrder = 1;
  group.add(waterMesh);
  return maxD;
}

// ---------- 카메라 조작 (three.js 예제 OrbitControls 는 cdnjs 에 없어 직접 구현) ----------
let orbit = {theta:-0.55, phi:0.42, dist:0, target:new THREE.Vector3()};
const MIN_DIST = 60;     // m. 더 가까이 가면 30 m 격자가 판때기로 보인다
function frameCamera(spanX, spanZ){
  orbit.dist = Math.max(spanX, spanZ) * 0.78;
  orbit.target.set(0, 0, 0);
  applyCamera();
}
function applyCamera(){
  orbit.phi = Math.max(0.12, Math.min(Math.PI/2 - 0.02, orbit.phi));
  const {theta, phi, dist, target} = orbit;
  camera.position.set(
    target.x + dist * Math.cos(phi) * Math.sin(theta),
    target.y + dist * Math.sin(phi),
    target.z + dist * Math.cos(phi) * Math.cos(theta));
  camera.lookAt(target);
  if(typeof scheduleDetail === "function") scheduleDetail();
  if(typeof scaleAlgae === "function") scaleAlgae();
  if(typeof liftChla === "function") liftChla();
  if(typeof scheduleBuildings === "function") scheduleBuildings();
}
function setupControls(spanX){
  const dom = renderer.domElement;
  let mode = null, px = 0, py = 0;
  dom.style.cursor = "grab";
  dom.addEventListener("contextmenu", e => e.preventDefault());
  dom.addEventListener("pointerdown", e=>{
    // 지도를 붙잡고 끄는 느낌이 기본이 되도록 왼쪽 드래그를 이동으로 둔다.
    // 회전은 오른쪽 드래그나 Shift+드래그.
    mode = (e.button === 2 || e.shiftKey) ? "rot" : "pan";
    px = e.clientX; py = e.clientY;
    try{ dom.setPointerCapture(e.pointerId); }catch(err){}
    dom.style.cursor = "grabbing";
  });
  dom.addEventListener("pointermove", e=>{
    if(!mode) return;
    const dx = e.clientX - px, dy = e.clientY - py;
    px = e.clientX; py = e.clientY;
    if(mode === "rot"){
      orbit.theta -= dx * 0.005;
      orbit.phi   += dy * 0.005;
    } else {
      const k = orbit.dist / innerHeight * 1.4;
      const right = new THREE.Vector3(Math.cos(orbit.theta), 0, -Math.sin(orbit.theta));
      const fwd   = new THREE.Vector3(Math.sin(orbit.theta), 0, Math.cos(orbit.theta));
      orbit.target.addScaledVector(right, -dx * k).addScaledVector(fwd, -dy * k);
    }
    applyCamera();
  });
  dom.addEventListener("pointermove", e=>{
    if(mode) return;                   // 회전·이동 중에는 읽지 않는다
    updateReadout(e.clientX, e.clientY);
  });
  dom.addEventListener("pointerleave", ()=>{ if(pickMark) pickMark.visible = false; });
  const end = e=>{ mode = null; dom.style.cursor = "grab"; };
  dom.addEventListener("pointerup", end);
  dom.addEventListener("pointercancel", end);
  dom.addEventListener("wheel", e=>{
    e.preventDefault();
    const zoomIn = e.deltaY < 0;
    // 화면 중앙이 아니라 커서가 가리키는 지점 쪽으로 들어가야 원하는 곳에 닿는다
    const g = zoomIn ? pickPoint(e.clientX, e.clientY) : null;
    orbit.dist *= zoomIn ? 1/1.12 : 1.12;
    // 아래로는 60 m 까지 내려간다(건물 사이까지). 위로는 구간 폭의 3배.
    orbit.dist = Math.max(MIN_DIST, Math.min(spanX * 3, orbit.dist));
    if(g){
      const wx = -SPANX/2 + g.c*RES, wz = -SPANZ/2 + g.r*RES;
      const k = 0.22;                      // 한 번에 다 끌어당기면 멀미가 난다
      orbit.target.x += (wx - orbit.target.x) * k;
      orbit.target.z += (wz - orbit.target.z) * k;
    }
    applyCamera();
  }, {passive:false});

  // 더블클릭 한 지점을 중심으로 삼고 한 단계 들어간다
  dom.addEventListener("dblclick", e=>{
    const g = pickPoint(e.clientX, e.clientY);
    if(!g) return;
    orbit.target.set(-SPANX/2 + g.c*RES,
                     elevAt(g.r*GW + g.c) * vex,
                     -SPANZ/2 + g.r*RES);
    orbit.dist = Math.max(MIN_DIST, orbit.dist * 0.45);
    applyCamera();
  });
}
/* ---- 가리킨 지점 읽기 ----
   정점 246만개짜리 메시에 레이캐스터를 쓰면 삼각형을 전수 검사해 마우스마다 멎는다.
   대신 표고 배열을 직접 가지고 있으므로 광선을 따라가며 지표 아래로 내려가는 지점을
   찾는다(높이장 레이마칭). 표본 수백 번이면 끝나고 격자 인덱스도 바로 나온다. */
function gridAt(x, z){
  const c = (x + SPANX/2) / RES, r = (z + SPANZ/2) / RES;
  if(c < 0 || r < 0 || c > GW-1 || r > GH-1) return null;
  return {c:Math.round(c), r:Math.round(r)};
}
function surfaceY(x, z){          // 세계좌표 기준 지표 높이(수직과장 반영)
  const g = gridAt(x, z);
  if(!g) return null;
  return elevAt(g.r * GW + g.c) * vex;
}
function pickPoint(clientX, clientY){
  const ndc = new THREE.Vector2(
    (clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction;
  const step = RES;                       // 격자 한 칸씩
  const maxT = Math.max(SPANX, SPANZ) * 3;
  let t = 0, prev = null;
  for(; t < maxT; t += step){
    const x = o.x + d.x*t, y = o.y + d.y*t, z = o.z + d.z*t;
    const s = surfaceY(x, z);
    if(s === null){ prev = null; continue; }
    if(y <= s){
      let lo = prev === null ? Math.max(0, t - step) : prev, hi = t;
      for(let k = 0; k < 14; k++){      // 이분 정밀화
        const m = (lo + hi) / 2;
        const yy = o.y + d.y*m, ss = surfaceY(o.x + d.x*m, o.z + d.z*m);
        if(ss !== null && yy <= ss) hi = m; else lo = m;
      }
      const x2 = o.x + d.x*hi, z2 = o.z + d.z*hi;
      return gridAt(x2, z2);
    }
    prev = t;
  }
  return null;
}

function animate(){
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}

