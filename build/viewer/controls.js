/* ---- 화면 설정(수직과장·항공영상·격자 간격·본류 거리·물 투명도) ----
   침수·녹조 두 화면이 그대로 공유한다. 격자 간격이나 표시 범위가 바뀌면 각 페이지가
   자기 레이어를 다시 만들어야 하므로 onGridChange() 로 알려준다. */
function wireControls(meta){
  if(typeof wireBuildings === "function") wireBuildings();
  const vwBtn = el("vwOn"), vwStat = el("vwStat");
  if(!VW.key){
    vwBtn.disabled = true; vwBtn.style.opacity = .45;
    vwStat.textContent = "브이월드 인증키가 없어 배경 위성영상(10 m)만 씁니다.";
  } else {
    vwBtn.setAttribute("aria-pressed", String(VW.on));
    vwBtn.style.background = VW.on ? "var(--accent-soft)" : "var(--surface-2)";
    vwBtn.style.borderColor = VW.on ? "var(--accent)" : "var(--border)";
    vwStat.textContent = VW.on
      ? "켜짐 — 확대하면 그 범위를 항공영상으로 덮습니다."
      : "꺼져 있음 — 켜면 확대한 범위를 항공영상으로 덮습니다.";
    vwBtn.addEventListener("click", ()=>{
      VW.on = !VW.on;
      vwBtn.setAttribute("aria-pressed", String(VW.on));
      vwBtn.style.background = VW.on ? "var(--accent-soft)" : "var(--surface-2)";
      vwBtn.style.borderColor = VW.on ? "var(--accent)" : "var(--border)";
      if(VW.on){ VW.lastSig = ""; refreshDetail().catch(()=>{}); }
      else {
        terrainMat.uniforms.uHasDetail.value = 0;
        vwStat.textContent = "꺼짐 — 배경 위성영상(10 m)";
      }
    });
  }

  el("mres").value = String(meshStep);
  el("mres").addEventListener("change", e=>{
    meshStep = +e.target.value;
    buildTerrain();
    if(current) buildWater(current);   // 물 메시도 같은 간격으로 다시 만든다
    if(typeof onGridChange === "function") onGridChange();
  });
  el("vex").addEventListener("input", e=>{
    const prev = vex;
    vex = +e.target.value;
    el("vexVal").textContent = vex + "×";
    if(group) group.scale.y = vex;
    if(orbit.target.y) { orbit.target.y = orbit.target.y / prev * vex; applyCamera(); }
    if(terrainMat && terrainMat.uniforms) terrainMat.uniforms.uVex.value = vex;
  });
  const dl = el("dlim");
  if(meta.dist_file){
    dl.max = Math.round((meta.dist_max_m || 15000) / 1000);
    dl.value = dl.max;
    el("dlimVal").textContent = dl.max + "km";
    dl.addEventListener("input", e=>{
      const km = +e.target.value;
      distLimit = km * 1000;
      el("dlimVal").textContent = km + "km";
      if(current) buildWater(current);
      if(typeof onGridChange === "function") onGridChange();
    });
  } else { dl.disabled = true; dl.parentElement.style.opacity = .45; }
  el("opa").addEventListener("input", e=>{
    waterOpacity = +e.target.value / 100;
    el("opaVal").textContent = e.target.value;
    if(waterMesh) waterMesh.material.uniforms.uMul.value = waterOpacity;
  });

}
