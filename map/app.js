/* 전국 조류경보 지점 지도.
 *
 * 빌드 도구 없이 도는 정적 페이지다 — GitHub Pages 에 그대로 올라가고(ADR-005 의 정적 우선),
 * 파일을 열면 코드가 바로 읽힌다. 기존 index.html 이 6.7MB 단일 파일이라 코드를 읽을 수
 * 없었던 문제를 반복하지 않으려고 HTML·CSS·JS 를 나눴다.
 *
 * 데이터: ../data/algae_latest.json (scripts/fetch_algae.py 가 매시 갱신, 68개 지점)
 * 배경지도: 브이월드 WMTS. 타일 주소가 {z}/{y}/{x} 순서인 점에 주의.
 */
const DATA_URL = "../data/algae_latest.json";        // 조류경보제 (주 1~2회)
const AUTO_URL = "../data/auto_latest.json";         // 수질자동측정망 (매시간)

/* Chl-a 값 색 램프 — 3D 뷰어(flood/)와 같은 값·같은 색을 쓴다. 두 화면에서 같은 농도가
   다른 색으로 보이면 안 된다. 낮음(파랑) → 높음(빨강), OKLab 인접 dE 16.3. */
const CHLA_RAMP = ["#2f6fe0", "#0e9aa8", "#57c06b", "#e8c93c", "#ef7c1f", "#c62317"];
const CHLA_STOPS = [5, 10, 25, 50, 100];   // mg/m3. 25 는 논문·대시보드의 고농도 기준
function chlaColor(v) {
  if (v === null || v === undefined) return "#c3cac7";
  let i = 0;
  while (i < CHLA_STOPS.length && v >= CHLA_STOPS[i]) i++;
  return CHLA_RAMP[i];
}
const LEVELS = ["대발생", "경계", "관심", "정상"];          // 심한 순
const COLOR = {
  "대발생": "#6e040b", "경계": "#b8381a", "관심": "#ffd95a",
  "정상": "#7e8984", "": "#c3cac7",
};
const RANK = { "대발생": 0, "경계": 1, "관심": 2, "정상": 3 };

const $ = (s) => document.querySelector(s);
const state = { rows: [], auto: [], level: null, kind: "all", q: "", sel: null,
                layers: { algae: true, auto: true }, markers: new Map() };

/* ---- 지도 ---- */
function vworldStyle(layer) {
  const ext = layer === "Satellite" ? "jpeg" : "png";
  return {
    version: 8,
    sources: {
      vw: {
        type: "raster", tileSize: 256, maxzoom: 18,
        // 브이월드는 {z}/{y}/{x} 순서다. x,y 를 바꿔 넣으면 빈 타일(XML 오류)이 온다.
        tiles: [`https://api.vworld.kr/req/wmts/1.0.0/${window.VWORLD_KEY}/${layer}/{z}/{y}/{x}.${ext}`],
        attribution: "국토교통부 브이월드",
      },
    },
    layers: [{ id: "vw", type: "raster", source: "vw" }],
  };
}

/* 지도는 WebGL 이 있어야 뜬다. 원격 데스크톱·구형 GPU·정책으로 막힌 환경에서는 생성이
 * 실패하는데, 그때 스크립트가 여기서 멈추면 **목록까지 안 나오고 화면이 빈다.**
 * 지도 없이도 목록·필터·상세는 쓸 수 있어야 하므로 실패를 감싸서 진행한다. */
let map = null;

function mapFailed(msg) {
  const el = document.getElementById("map");
  el.innerHTML = `<div class="mapfail">
      <b>지도를 표시할 수 없습니다.</b>
      <span>${msg}</span>
      <span>왼쪽 목록과 지점별 상세는 그대로 쓰실 수 있습니다.</span>
    </div>`;
  document.querySelector(".basemap").hidden = true;
}

try {
  map = new maplibregl.Map({
    container: "map",
    style: vworldStyle("Base"),
    center: [127.8, 36.3],
    zoom: 6.4,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 110 }), "bottom-left");

  // 타일이 안 오는 경우(망 차단, 인증키 한도)에도 원인을 화면에 알린다.
  let tileWarned = false;
  map.on("error", (e) => {
    const m = String(e && e.error && e.error.message || "");
    if (!tileWarned && /tile|fetch|network|Failed/i.test(m)) {
      tileWarned = true;
      document.getElementById("tilewarn").hidden = false;
    }
  });

  document.querySelectorAll(".bm").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".bm").forEach((x) => x.classList.toggle("on", x === b));
      // 스타일을 갈아끼우면 마커(DOM 요소)는 그대로 남는다 — 다시 그릴 필요 없다.
      map.setStyle(vworldStyle(b.dataset.style));
    });
  });
} catch (err) {
  mapFailed(navigator.userAgent && !window.WebGL2RenderingContext
    ? "이 브라우저가 WebGL 을 지원하지 않습니다."
    : "브라우저에서 WebGL 을 쓸 수 없습니다(원격 데스크톱·그래픽 드라이버·보안 정책 등).");
}

/* ---- 데이터 ---- */
function fmtDate(s) { return (s || "").replace(/\./g, ".").replace(/\.$/, ""); }
function fmtNum(v) { return v === null || v === undefined ? "–" : Math.round(v).toLocaleString(); }

async function load() {
  const res = await fetch(DATA_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`데이터를 불러오지 못했습니다 (${res.status})`);
  const d = await res.json();
  state.rows = (d.rows || []).filter((r) => r.lat !== null && r.lon !== null);

  const t = new Date(d.updated_at);
  const dates = state.rows.map((r) => r.date).filter(Boolean).sort();
  $("#updated").textContent =
    `지점 ${state.rows.length}곳 · 최근 채수 ${fmtDate(dates[dates.length - 1] || "–")}` +
    ` · 수집 ${t.getMonth() + 1}.${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:` +
    `${String(t.getMinutes()).padStart(2, "0")}`;

  // 자동측정망은 없어도 조류경보 지도는 떠야 한다 — 실패를 삼키고 진행한다.
  try {
    const ar = await fetch(AUTO_URL, { cache: "no-store" });
    if (ar.ok) {
      const ad = await ar.json();
      state.auto = (ad.rows || []).filter((r) => r.lat && r.lon);
      const t = state.auto.map((r) => r.time).filter(Boolean).sort();
      $("#autoInfo").textContent = state.auto.length
        ? `자동측정망 ${state.auto.length}곳 · Chl-a ${state.auto.filter((r) => r.chla !== null).length}곳` +
          ` · 최신 ${t[t.length - 1] || "–"}`
        : "";
    }
  } catch (e) { /* 자동측정망 없이 진행 */ }

  buildTally();
  buildLegend();
  buildMarkers();
  render();
  fitToData();
}

/* 첫 화면을 지점 분포에 맞춘다. 고정 zoom 으로 두면 북한·일본이 화면의 절반을 차지한다. */
function fitToData() {
  if (!map) return;
  const b = new maplibregl.LngLatBounds();
  state.rows.forEach((r) => b.extend([r.lon, r.lat]));
  map.fitBounds(b, { padding: { top: 60, bottom: 40, left: 40, right: 40 }, duration: 0 });
}

/* ---- 단계별 집계(겸 필터 버튼) ---- */
function buildTally() {
  const counts = {};
  state.rows.forEach((r) => { counts[r.level || ""] = (counts[r.level || ""] || 0) + 1; });
  $("#tally").innerHTML = LEVELS.map((lv) => `
    <button class="tw" data-level="${lv}" aria-pressed="false">
      <span class="n">${counts[lv] || 0}</span>
      <span class="l"><i class="dot" style="background:${COLOR[lv]}"></i>${lv}</span>
    </button>`).join("");
  $("#tally").querySelectorAll(".tw").forEach((b) => {
    b.addEventListener("click", () => {
      state.level = state.level === b.dataset.level ? null : b.dataset.level;
      $("#tally").querySelectorAll(".tw").forEach((x) =>
        x.setAttribute("aria-pressed", String(x.dataset.level === state.level)));
      render();
    });
  });
}

function buildLegend() {
  const algae = LEVELS.map((lv) =>
    `<div><i class="dot" style="background:${COLOR[lv]}"></i>${lv}</div>`).join("") +
    `<div><i class="dot" style="background:#fff;border:2px dashed #999"></i>분석중</div>`;
  const stops = ["~5", "5~10", "10~25", "25~50", "50~100", "100~"];
  const auto = CHLA_RAMP.map((c, i) =>
    `<div><i class="sq" style="background:${c}"></i>${stops[i]}</div>`).join("");
  $("#legend").innerHTML =
    `<div class="lgtitle">조류경보 단계 <small>주 1~2회</small></div>${algae}` +
    `<div class="lgtitle">자동측정망 Chl-a <small>매시간 · mg/m³</small></div>${auto}`;
}

/* ---- 마커 ----
   망이 다르면 모양으로 구분한다. 색만 다르게 하면 "같은 척도의 다른 값"으로 읽힌다.
     동그라미 = 조류경보제(세포수 기준 단계)   네모 = 자동측정망(Chl-a 농도) */
function buildMarkers() {
  state.auto.forEach((r) => {
    const el = document.createElement("div");
    el.className = "mk mk-auto" + (r.chla === null ? " nodata" : "");
    el.style.background = chlaColor(r.chla);
    el.title = `${r.name} (자동측정망)`;
    el.addEventListener("click", (e) => { e.stopPropagation(); select("A:" + r.code, true); });
    const mk = map
      ? new maplibregl.Marker({ element: el }).setLngLat([r.lon, r.lat]).addTo(map)
      : null;
    state.markers.set("A:" + r.code, { marker: mk, el });
  });

  state.rows.forEach((r) => {
    const el = document.createElement("div");
    el.className = "mk" + (r.pending ? " pending" : "");
    el.style.background = COLOR[r.level || ""];
    el.title = `${r.water} ${r.station}`;
    el.addEventListener("click", (e) => { e.stopPropagation(); select(r.code, true); });
    if (map) {
      const mk = new maplibregl.Marker({ element: el }).setLngLat([r.lon, r.lat]).addTo(map);
      state.markers.set(r.code, { marker: mk, el });
    } else {
      state.markers.set(r.code, { marker: null, el });   // 지도 없이도 목록 필터는 동작한다
    }
  });
  if (map) map.on("click", () => select(null));
}

/* ---- 목록 ---- */
function visible() {
  const q = state.q.trim();
  return state.rows.filter((r) =>
    (!state.level || r.level === state.level) &&
    (state.kind === "all" || r.kind === state.kind) &&
    (!q || `${r.water} ${r.station} ${r.addr || ""}`.includes(q))
  ).sort((a, b) =>
    (RANK[a.level] ?? 9) - (RANK[b.level] ?? 9) || (b.cell_count || 0) - (a.cell_count || 0));
}

function visibleAuto() {
  if (!state.layers.auto) return [];
  const q = state.q.trim();
  return state.auto
    .filter((r) => (!q || `${r.name} ${r.basin}`.includes(q)))
    .sort((a, b) => (b.chla ?? -1) - (a.chla ?? -1));
}

function render() {
  const rows = state.layers.algae ? visible() : [];
  const autos = visibleAuto();
  const shown = new Set([...rows.map((r) => r.code), ...autos.map((r) => "A:" + r.code)]);
  state.markers.forEach((m, code) => {
    m.el.style.display = shown.has(code) ? "" : "none";
  });

  $("#list").innerHTML = rows.length ? rows.map((r) => `
    <li><button class="row" data-code="${r.code}" aria-current="${r.code === state.sel}">
      <span class="bar" style="background:${COLOR[r.level || ""]}"></span>
      <span class="nm">${r.water} ${r.station}
        <small>${r.kind} · 채수 ${fmtDate(r.date)}${r.pending ? " · 최신분 분석중" : ""}${
          r.level !== r.level_latest ? ` · 최근 1건 기준 ${r.level_latest}` : ""}</small></span>
      <span class="v"><b>${fmtNum(r.cell_count)}</b>cells/mL</span>
    </button></li>`).join("")
    : `<li class="empty">조건에 맞는 지점이 없습니다.</li>`;

  if (autos.length) {
    $("#list").insertAdjacentHTML("beforeend",
      `<li class="grp">수질자동측정망 <small>매시간 · Chl-a mg/m³</small></li>` +
      autos.map((r) => `
        <li><button class="row" data-code="A:${r.code}" aria-current="${"A:" + r.code === state.sel}">
          <span class="bar sq" style="background:${chlaColor(r.chla)}"></span>
          <span class="nm">${r.name}
            <small>${r.basin} · ${r.time || "관측 없음"}</small></span>
          <span class="v"><b>${r.chla === null ? "–" : r.chla.toFixed(1)}</b>mg/m³</span>
        </button></li>`).join(""));
  }

  $("#list").querySelectorAll(".row").forEach((b) =>
    b.addEventListener("click", () => select(b.dataset.code, true)));
}

/* ---- 선택 ---- */
function select(code, fly) {
  state.sel = state.sel === code ? null : code;
  state.markers.forEach((m, c) => m.el.classList.toggle("sel", c === state.sel));
  $("#list").querySelectorAll(".row").forEach((b) =>
    b.setAttribute("aria-current", String(b.dataset.code === state.sel)));

  const box = $("#detail");
  if (state.sel && state.sel.startsWith("A:")) return detailAuto(box);

  const r = state.rows.find((x) => x.code === state.sel);
  if (!r) { box.hidden = true; return; }
  if (fly && map) map.flyTo({ center: [r.lon, r.lat], zoom: Math.max(map.getZoom(), 10), speed: 1.1 });

  const basis = r.level_basis_n >= 2
    ? `최근 2회 채수로 판정했습니다.`
    : `<b>최근 1건만으로 판정했습니다</b> — 근거가 약합니다.`;
  const diff = r.level !== r.level_latest
    ? `<br>최근 1건만 보면 <b>${r.level_latest}</b>입니다(직전 채수가 기준 미만).` : "";

  box.hidden = false;
  box.innerHTML = `
    <button class="close" aria-label="닫기">×</button>
    <h2>${r.water} ${r.station}</h2>
    <p class="addr">${r.addr || ""} · ${r.kind}</p>
    <p><span class="lv" style="background:${COLOR[r.level || ""]};
       ${r.level === "관심" ? "color:#2a2410" : ""}">${r.level || "관측없음"}</span></p>
    <dl>
      <dt>유해남조류</dt><dd>${fmtNum(r.cell_count)} cells/mL</dd>
      <dt>Chl-a</dt><dd>${r.chla === null ? "–" : r.chla.toFixed(1)} mg/m³</dd>
      <dt>수온</dt><dd>${r.temp === null ? "–" : r.temp.toFixed(1)} ℃</dd>
      <dt>채수일</dt><dd>${fmtDate(r.date)}</dd>
    </dl>
    <p class="basis">${basis}${diff}
      ${r.pending ? `<br>${fmtDate(r.pending_date)} 채수분은 분석 중입니다.` : ""}</p>`;
  box.querySelector(".close").addEventListener("click", () => select(null));
}

/* 자동측정망 지점 상세. 조류경보제와 측정 방식·주기가 달라 화면에서도 구분해 적는다. */
function detailAuto(box) {
  const r = state.auto.find((x) => "A:" + x.code === state.sel);
  if (!r) { box.hidden = true; return; }
  if (map) map.flyTo({ center: [r.lon, r.lat], zoom: Math.max(map.getZoom(), 10), speed: 1.1 });
  const v = (x, u, d = 1) => (x === null || x === undefined ? "–" : `${x.toFixed(d)} ${u}`);
  box.hidden = false;
  box.innerHTML = `
    <button class="close" aria-label="닫기">×</button>
    <h2>${r.name} <span class="tag">자동측정망</span></h2>
    <p class="addr">${r.basin} 수계 · ${r.time || "관측 없음"}</p>
    <p><span class="lv" style="background:${chlaColor(r.chla)}${r.chla !== null && r.chla < 25 ? ";color:#12263f" : ""}">
       Chl-a ${r.chla === null ? "미측정" : r.chla.toFixed(1) + " mg/m³"}</span></p>
    <dl>
      <dt>수온</dt><dd>${v(r.temp, "℃")}</dd>
      <dt>탁도</dt><dd>${v(r.turbidity, "NTU")}</dd>
      <dt>TOC</dt><dd>${v(r.toc, "mg/L")}</dd>
      <dt>총질소</dt><dd>${v(r.tn, "mg/L", 2)}</dd>
      <dt>총인</dt><dd>${v(r.tp, "mg/L", 3)}</dd>
    </dl>
    <p class="basis">센서로 1시간마다 측정한 값입니다(지연 1~2시간).
      조류경보 단계는 채수·현미경 계수로 정하므로 이 값과 직접 비교하지 마십시오.
      ${r.chla === null ? "<br>이 지점은 Chl-a 를 측정하지 않습니다." : ""}</p>`;
  box.querySelector(".close").addEventListener("click", () => select(null));
}

/* ---- 필터 입력 ---- */
$("#q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
document.querySelectorAll("#layerChips .chip").forEach((b) => {
  b.addEventListener("click", () => {
    const k = b.dataset.layer;
    state.layers[k] = !state.layers[k];
    b.classList.toggle("on", state.layers[k]);
    render();
  });
});
document.querySelectorAll("#kindChips .chip").forEach((b) => {
  b.addEventListener("click", () => {
    state.kind = b.dataset.kind;
    document.querySelectorAll("#kindChips .chip").forEach((x) => x.classList.toggle("on", x === b));
    render();
  });
});

load().catch((err) => {
  $("#updated").textContent = err.message;
  $("#list").innerHTML = `<li class="empty">${err.message}</li>`;
});
