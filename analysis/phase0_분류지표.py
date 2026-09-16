"""Phase 0 — 위성 기반 녹조 탐지의 "쓸 수 있음" 판정 (ADR-009 통과선 대조).

회귀 R2 만으로는 서비스가 무엇을 주장할 수 있는지 판단할 수 없어서, 세 축을 따로 잰다.
  ① 경보 초과 판정   임계값 초과 이진 분류 (AUC·재현율·정밀도)
  ② 공간 순위 재현   같은 날짜 여러 지점의 실측 순위 vs 추정 순위 (Spearman)
  ③ 시간 방향 일치   같은 지점 연속 관측의 증가/감소 방향 일치율

논문 코드(chla/src)를 고치지 않고 경로만 덮어써 그대로 재사용한다. 저장된 모델을 학습자료에
그대로 쓰면 성능이 부풀려지므로, 측정소 단위 GroupKFold 의 **out-of-fold 예측**으로만 계산한다.

실행 (pandas·scikit-learn·xgboost·scipy·openpyxl 필요, 약 3분):
    python analysis/phase0_분류지표.py

입력은 이 저장소 밖에 있다 — 학위논문 자료(데이터/DS0.xlsx)와 분석 코드(분석/chla/src).
경로는 아래 SRC/DATA_DIR 상수에서 고친다. 결과 요약은 docs/adr/009 에 적어 둔다.
"""
import pathlib
import sys

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.metrics import roc_auc_score, precision_score, recall_score, f1_score

SRC = pathlib.Path("/home/gw/0. 학위논문/분석/chla/src")
sys.path.insert(0, str(SRC))

import config as C                                            # noqa: E402
# 논문 코드는 Windows 경로가 박혀 있다(H:\...). 파일을 고치지 않고 여기서만 덮어쓴다.
C.DATA_DIR = pathlib.Path("/home/gw/0. 학위논문/데이터")
C.PROJ_DIR = pathlib.Path("/home/gw/0. 학위논문/분석/chla")
C.OUT_DIR = C.PROJ_DIR / "outputs"
C.TABLE_DIR, C.FIG_DIR, C.MODEL_DIR = (C.OUT_DIR / "tables", C.OUT_DIR / "figures",
                                       C.OUT_DIR / "models")
C.DATASETS = {k: C.DATA_DIR / f"{k}.xlsx" for k in ("DS0", "DS1", "DS2")}

import data as D        # noqa: E402
import features as F    # noqa: E402
import models as M      # noqa: E402
import evaluate as E    # noqa: E402

DS, WINDOW, MODEL = "DS0", "3x3", "XGBoost"     # 논문 최고 성능 조합
THRESHOLDS = [25.0, 50.0]                        # mg/m3


def oof_predictions():
    df, counts = D.prepare(DS, dos=False)
    df = F.add_features(df)
    d = E.subset(df)
    groups = d[C.COL_STATION].to_numpy()
    y_log = d["ln_chla"].to_numpy()
    cols, est, params = M.ml_specs(WINDOW)[MODEL]
    X = d[cols].to_numpy(float)
    print(f"{DS} · {WINDOW} · {MODEL} — 표본 {len(d)}건, 측정소 {len(set(groups))}곳, "
          f"입력 {len(cols)}개")
    print("하이퍼파라미터 탐색 중…", flush=True)
    best, best_params = E.tune_once(est, params, X, y_log, groups)
    folds, oof = E.run_cv(best, X, y_log, E.group_splits(groups))
    print(f"  GroupCV R2 = {folds['R2'].mean():.3f}  RMSE = {folds['RMSE'].mean():.2f} "
          f"MAE = {folds['MAE'].mean():.2f}   (논문 보고값 R2 0.543 / RMSE 12.2 / MAE 7.88)")
    return pd.DataFrame({
        "station": d[C.COL_STATION].to_numpy(),
        "date": pd.to_datetime(d[C.COL_DATE].to_numpy()),
        "obs": np.exp(y_log), "pred": oof,
    }).dropna(subset=["pred"])


def axis1_classification(t):
    print("\n① 경보 초과 판정 — 통과선: 재현율 ≥ 0.70, 정밀도 ≥ 0.50, AUC ≥ 0.80")
    rows = []
    for thr in THRESHOLDS:
        yt, yp = (t.obs >= thr).to_numpy(), (t.pred >= thr).to_numpy()
        n_pos = int(yt.sum())
        if n_pos < 5:
            print(f"  {thr:.0f} mg/m3: 양성 {n_pos}건뿐 — 판정 불가")
            continue
        auc = roc_auc_score(yt, t.pred.to_numpy())      # 점수는 연속 추정값
        rec, prec = recall_score(yt, yp), precision_score(yt, yp, zero_division=0)
        f1 = f1_score(yt, yp, zero_division=0)
        ok = "통과" if (rec >= .70 and prec >= .50 and auc >= .80) else "미달"
        print(f"  {thr:.0f} mg/m3 초과 (양성 {n_pos}/{len(yt)}, {n_pos/len(yt)*100:.1f}%)  "
              f"AUC {auc:.3f}  재현율 {rec:.3f}  정밀도 {prec:.3f}  F1 {f1:.3f}  → {ok}")
        rows.append({"threshold": thr, "n_pos": n_pos, "AUC": auc,
                     "recall": rec, "precision": prec, "F1": f1, "pass": ok})
    return rows


def axis2_spatial_rank(t, min_stations=3):
    print(f"\n② 공간 순위 재현 — 통과선: 날짜별 Spearman 중위 ≥ 0.60 "
          f"(같은 날 {min_stations}개 지점 이상)")
    rs = []
    for date, g in t.groupby("date"):
        if g.station.nunique() < min_stations:
            continue
        r = spearmanr(g.obs, g.pred).statistic
        if not np.isnan(r):
            rs.append(r)
    if not rs:
        print("  해당 날짜 없음 — 판정 불가")
        return None
    rs = np.array(rs)
    med = float(np.median(rs))
    print(f"  날짜 {len(rs)}개  중위 {med:.3f}  평균 {rs.mean():.3f}  "
          f"(25% {np.percentile(rs,25):.3f} / 75% {np.percentile(rs,75):.3f})  "
          f"양의 상관 비율 {np.mean(rs>0)*100:.0f}%  → {'통과' if med>=.60 else '미달'}")
    return {"n_dates": len(rs), "median": med, "mean": float(rs.mean())}


def axis3_direction(t):
    print("\n③ 시간 방향 일치 — 통과선: 증감 방향 일치율 ≥ 70%")
    hit = tot = 0
    for st, g in t.sort_values("date").groupby("station"):
        if len(g) < 2:
            continue
        do, dp = np.diff(g.obs.to_numpy()), np.diff(g.pred.to_numpy())
        m = do != 0                       # 실측이 그대로인 구간은 방향이 없다
        hit += int(np.sum(np.sign(do[m]) == np.sign(dp[m])))
        tot += int(m.sum())
    if tot == 0:
        print("  연속 관측 쌍 없음 — 판정 불가")
        return None
    rate = hit / tot
    print(f"  연속 관측 쌍 {tot}개  일치 {hit}개  일치율 {rate*100:.1f}%  "
          f"→ {'통과' if rate>=.70 else '미달'}")
    return {"n_pairs": tot, "rate": rate}


if __name__ == "__main__":
    t = oof_predictions()
    c = axis1_classification(t)
    s = axis2_spatial_rank(t)
    d3 = axis3_direction(t)
    out = pathlib.Path(__file__).resolve().parent / "phase0_oof.csv"
    t.to_csv(out, index=False, encoding="utf-8-sig")
    print(f"\nOOF 예측 저장: {out} ({len(t)}건)")
