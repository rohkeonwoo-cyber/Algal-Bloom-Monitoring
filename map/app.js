/* 전국 조류경보 지점 지도.
 *
 * 빌드 도구 없이 도는 정적 페이지다 — GitHub Pages 에 그대로 올라가고(ADR-005 의 정적 우선),
 * 파일을 열면 코드가 바로 읽힌다. 기존 index.html 이 6.7MB 단일 파일이라 코드를 읽을 수
 * 없었던 문제를 반복하지 않으려고 HTML·CSS·JS 를 나눴다.
 *
 * 데이터: ../data/algae_latest.json (scripts/fetch_algae.py 가 매시 갱신, 68개 지점)
 * 배경지도: 브이월드 WMTS. 타일 주소가 {z}/{y}/{x} 순서인 점에 주의.
 */
const DATA_URL = "../data/algae_latest.json";
const LEVELS = ["대발생", "경계", "관심", "정상"];          // 심한 순
const COLOR = {
  "대발생": "#6e040b", "경계": "#b8381a", "관심": "#ffd95a",
  "정상": "#7e8984", "": "#c3cac7",
};
const RANK = { "대발생": 0, "경계": 1, "관심": 2, "정상": 3 };

const $ = (s) => document.querySelector(s);
const state = { rows: [], level: null, kind: "all", q: "", sel: null, markers: new Map() };

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

const map = new maplibregl.Map({
  container: "map",
  style: vworldStyle("Base"),
  center: [127.8, 36.3],
  zoom: 6.4,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
map.addControl(new maplibregl.ScaleControl({ maxWidth: 110 }), "bottom-left");

document.querySelectorAll(".bm").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".bm").forEach((x) => x.classList.toggle("on", x === b));
    // 스타일을 갈아끼우면 마커(DOM 요소)는 그대로 남는다 — 다시 그릴 필요 없다.
    map.setStyle(vworldStyle(b.dataset.style));
  });
});

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

  buildTally();
  buildLegend();
  buildMarkers();
  render();
  fitToData();
}

/* 첫 화면을 지점 분포에 맞춘다. 고정 zoom 으로 두면 북한·일본이 화면의 절반을 차지한다. */
function fitToData() {
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
  $("#legend").innerHTML = LEVELS.map((lv) =>
    `<div><i class="dot" style="background:${COLOR[lv]}"></i>${lv}</div>`).join("") +
    `<div><i class="dot" style="background:#fff;border:2px dashed #999"></i>분석중</div>`;
}

/* ---- 마커 ---- */
function buildMarkers() {
  state.rows.forEach((r) => {
    const el = document.createElement("div");
    el.className = "mk" + (r.pending ? " pending" : "");
    el.style.background = COLOR[r.level || ""];
    el.title = `${r.water} ${r.station}`;
    el.addEventListener("click", (e) => { e.stopPropagation(); select(r.code, true); });
    const mk = new maplibregl.Marker({ element: el }).setLngLat([r.lon, r.lat]).addTo(map);
    state.markers.set(r.code, { marker: mk, el });
  });
  map.on("click", () => select(null));
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

function render() {
  const rows = visible();
  const shown = new Set(rows.map((r) => r.code));
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

  $("#list").querySelectorAll(".row").forEach((b) =>
    b.addEventListener("click", () => select(b.dataset.code, true)));
}

/* ---- 선택 ---- */
function select(code, fly) {
  state.sel = state.sel === code ? null : code;
  state.markers.forEach((m, c) => m.el.classList.toggle("sel", c === state.sel));
  $("#list").querySelectorAll(".row").forEach((b) =>
    b.setAttribute("aria-current", String(b.dataset.code === state.sel)));

  const r = state.rows.find((x) => x.code === state.sel);
  const box = $("#detail");
  if (!r) { box.hidden = true; return; }
  if (fly) map.flyTo({ center: [r.lon, r.lat], zoom: Math.max(map.getZoom(), 10), speed: 1.1 });

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

/* ---- 필터 입력 ---- */
$("#q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
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
