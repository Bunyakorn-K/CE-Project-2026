#!/usr/bin/env python3
"""Compare hourly cycle-count candidates against a seasonal-naive baseline.

WHY. `docs/06_ml/ml-training-data-guide.md` §7 names three candidate families
(Prophet, SARIMA, gradient boosting) and §5.3 used to say the warehouse was 19
days short of the 90-day minimum. It is not short any more (110 distinct days,
measured 2026-11-09), so the comparison the guide planned can finally be run.

THE SPLIT IS FIXED AND NEVER SHUFFLED. The last 14 days (336 hours) of the
series are held out; everything before them is training. A random split on a
time series lets the model see the future, and a rolling-origin evaluation on
110 days would have too few origins to say anything.

WHAT THE NUMBERS MEAN. MAE is in cycles per hour. MAPE is reported over hours
with a non-zero actual only, because a cycle count of 0 makes percentage error
undefined — saying "MAPE 12 %" over a series with many zeros without stating
that would be a number that cannot be compared to anything.

THE INPUT contains no fake zeros. `fact_ml_features` emits the `2026-07-27`
source-gap day as NULL, and this script drops those rows rather than filling
them: a gap is a discontinuity, not a demand collapse. Each model is told about
it in the way that model can accept it (Prophet: absent timestamps; SARIMAX:
NaN observations with the time index preserved; seasonal naive: a fallback to
the same hour-of-week's training median).

USAGE
    python compare_hourly_cycles.py --csv hourly-cycles.csv --holdout-days 14
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

SEASON_HOURS = 168  # one week


def load_series(path: str) -> pd.Series:
    frame = pd.read_csv(path)
    frame["hour"] = pd.to_datetime(frame["hour"])
    series = frame.set_index("hour")["cycles"].astype(float)
    # Reindex to a complete hourly range: a missing timestamp is a gap, and it
    # must appear as NaN rather than as an absent row nobody notices.
    full = pd.date_range(series.index.min(), series.index.max(), freq="h")
    return series.reindex(full)


def metrics(actual: np.ndarray, predicted: np.ndarray) -> dict:
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    mask = np.isfinite(actual) & np.isfinite(predicted)
    a = actual[mask]
    p = predicted[mask]
    if len(a) == 0:
        return {"n": 0, "mae": None, "rmse": None, "mape_pct": None, "mape_n": 0}
    mae = float(np.mean(np.abs(a - p)))
    rmse = float(math.sqrt(np.mean((a - p) ** 2)))
    nonzero = a != 0
    mape = float(np.mean(np.abs((a[nonzero] - p[nonzero]) / a[nonzero])) * 100) if nonzero.any() else None
    return {
        "n": int(len(a)),
        "mae": round(mae, 4),
        "rmse": round(rmse, 4),
        "mape_pct": None if mape is None else round(mape, 2),
        "mape_n": int(nonzero.sum()),
    }


def seasonal_naive(train: pd.Series, horizon_index: pd.DatetimeIndex) -> np.ndarray:
    """y_hat(t) = y(t - 168h), with a same-hour-of-week median where that is a gap."""
    profile = train.copy()
    profile.index = profile.index
    by_hour_of_week = profile.groupby([profile.index.dayofweek, profile.index.hour]).median()
    out = []
    for timestamp in horizon_index:
        past = timestamp - pd.Timedelta(hours=SEASON_HOURS)
        if past in train.index and pd.notna(train.loc[past]):
            out.append(float(train.loc[past]))
        else:
            key = (timestamp.dayofweek, timestamp.hour)
            out.append(float(by_hour_of_week.get(key, np.nan)))
    return np.array(out)


def fit_sarima(train: pd.Series, horizon_index: pd.DatetimeIndex) -> np.ndarray:
    from statsmodels.tsa.statespace.sarimax import SARIMAX

    # `missing="drop"` keeps the time index while ignoring the gap day's NaNs,
    # so the weekly seasonality index is not shifted by the missing 24 hours.
    model = SARIMAX(
        train,
        order=(1, 0, 1),
        seasonal_order=(1, 0, 1, 24),
        enforce_stationarity=False,
        enforce_invertibility=False,
        missing="drop",
    )
    fitted = model.fit(disp=False, maxiter=50)
    forecast = fitted.forecast(steps=len(horizon_index))
    return np.asarray(forecast, dtype=float)


def fit_prophet(train: pd.Series, horizon_index: pd.DatetimeIndex) -> np.ndarray:
    from prophet import Prophet

    frame = pd.DataFrame({"ds": train.index, "y": train.values}).dropna()
    model = Prophet(
        daily_seasonality=True,
        weekly_seasonality=True,
        yearly_seasonality=False,  # 110 days cannot support a yearly cycle
        interval_width=0.8,
    )
    model.fit(frame)
    future = pd.DataFrame({"ds": horizon_index})
    forecast = model.predict(future)
    return forecast["yhat"].to_numpy(dtype=float)


def fit_gbm(train: pd.Series, horizon_index: pd.DatetimeIndex) -> np.ndarray:
    """Gradient-boosted trees on calendar features only.

    No lag features: on a 336-hour horizon a lag needs recursion, and a
    recursive GBM fed its own predictions is a different (and much weaker)
    claim than "the calendar explains the profile". This model learns the
    hour-of-week shape and cannot extrapolate a trend — stated, not hidden.
    """
    from sklearn.ensemble import HistGradientBoostingRegressor

    def features(index: pd.DatetimeIndex) -> np.ndarray:
        hour = np.asarray(index.hour, dtype=float)
        dayofweek = np.asarray(index.dayofweek, dtype=float)
        month = np.asarray(index.month, dtype=float)
        return np.column_stack(
            [
                hour,
                dayofweek,
                (dayofweek >= 5).astype(float),
                month,
                np.sin(2 * np.pi * hour / 24),
                np.cos(2 * np.pi * hour / 24),
                np.sin(2 * np.pi * dayofweek / 7),
                np.cos(2 * np.pi * dayofweek / 7),
            ]
        )

    mask = train.notna()
    model = HistGradientBoostingRegressor(max_iter=400, learning_rate=0.06, max_depth=None, random_state=7)
    model.fit(features(train.index[mask]), train[mask].to_numpy(dtype=float))
    return model.predict(features(horizon_index))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True)
    parser.add_argument("--holdout-days", type=int, default=14)
    parser.add_argument("--skip", default="", help="comma-separated model names to skip")
    args = parser.parse_args()

    series = load_series(args.csv)
    horizon = args.holdout_days * 24
    train = series.iloc[:-horizon]
    test = series.iloc[-horizon:]

    skipped = {name.strip() for name in args.skip.split(",") if name.strip()}
    results: dict[str, dict] = {}

    results["seasonal_naive"] = metrics(
        test.to_numpy(), seasonal_naive(train, test.index)
    )

    candidates = {
        "sarima": fit_sarima,
        "prophet": fit_prophet,
        "gbm": fit_gbm,
    }
    for name, fitter in candidates.items():
        if name in skipped:
            results[name] = {"skipped": True}
            continue
        try:
            results[name] = metrics(test.to_numpy(), fitter(train, test.index))
        except Exception as error:  # noqa: BLE001 - a candidate that cannot fit is a result
            results[name] = {"error": f"{type(error).__name__}: {error}"}

    print(
        json.dumps(
            {
                "series": args.csv,
                "hours_total": int(len(series)),
                "gap_hours_nan": int(series.isna().sum()),
                "train_hours": int(len(train)),
                "holdout_hours": int(len(test)),
                "holdout_start": str(test.index.min()),
                "holdout_end": str(test.index.max()),
                "results": results,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
