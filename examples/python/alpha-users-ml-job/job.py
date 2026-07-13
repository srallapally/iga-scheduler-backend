"""
Alpha Users ML Anomaly Detection Job

Queries all managed users in the PingOne AIC alpha realm via the IGA Scheduler
SDK, builds a numeric feature matrix from account attributes, and runs
IsolationForest to flag accounts with anomalous access patterns.

Parameters:
  pageSize      (int, default 200)  - IDM query page size per request
  contamination (float, default 0.05) - expected fraction of anomalous accounts
  fields        (str, optional)     - comma-separated IDM field names to fetch
                                      (defaults to a sensible set below)
"""

import json

import numpy as np
import pandas as pd
from dateutil import parser as dateparser
from dateutil.utils import today
from iga_scheduler import SchedulerJob, run_job
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler

# IDM fields fetched from alpha_user. Adjust to match your tenant's schema.
DEFAULT_FIELDS = ",".join([
    "_id",
    "userName",
    "accountStatus",
    "createDate",
    "lastSync",
    "roles",
    "memberOf",
])

IDM_USER_ENDPOINT = "/openidm/managed/alpha_user"


def _days_since(iso_str, reference):
    """Return days between an ISO 8601 timestamp and reference date, or NaN."""
    if not iso_str:
        return float("nan")
    try:
        dt = dateparser.parse(iso_str)
        delta = reference - dt.replace(tzinfo=None)
        return max(delta.days, 0)
    except (ValueError, TypeError):
        return float("nan")


def _count(value):
    """Return len of a list/None field, or 0."""
    if isinstance(value, list):
        return len(value)
    return 0


def fetch_all_users(iga_client, page_size, fields):
    """Paginate through /openidm/managed/alpha_user and return all user dicts."""
    users = []
    cookie = None

    while True:
        params = f"_queryFilter=true&_pageSize={page_size}&_fields={fields}"
        if cookie:
            params += f"&_pagedResultsCookie={cookie}"
        path = f"{IDM_USER_ENDPOINT}?{params}"

        response = iga_client.execute("GET", path, None)
        batch = response.get("result", [])
        users.extend(batch)

        cookie = response.get("pagedResultsCookie")
        if not cookie:
            break

    return users


def build_feature_matrix(users):
    """
    Convert raw user dicts to a numeric DataFrame.

    Features:
      account_age_days   - days since createDate (older = higher number)
      days_since_sync    - days since lastSync (stale sync = higher number)
      role_count         - number of roles assigned
      group_count        - number of groups (memberOf)
      is_disabled        - 1 if accountStatus != "active", else 0
    """
    reference = today()
    rows = []

    for u in users:
        rows.append({
            "_id": u.get("_id", ""),
            "userName": u.get("userName", ""),
            "account_age_days": _days_since(u.get("createDate"), reference),
            "days_since_sync": _days_since(u.get("lastSync"), reference),
            "role_count": _count(u.get("roles")),
            "group_count": _count(u.get("memberOf")),
            "is_disabled": 0 if u.get("accountStatus") == "active" else 1,
        })

    return pd.DataFrame(rows)


def run_anomaly_detection(df, contamination):
    """
    Run IsolationForest on the numeric columns and return a copy of df with:
      anomaly_score  - raw decision function score (lower = more anomalous)
      is_anomaly     - True for flagged accounts
    """
    feature_cols = [
        "account_age_days",
        "days_since_sync",
        "role_count",
        "group_count",
        "is_disabled",
    ]

    # Drop rows where all features are NaN, fill remaining NaN with column median.
    X = df[feature_cols].copy()
    X = X.dropna(how="all")
    X = X.fillna(X.median(numeric_only=True))

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    model = IsolationForest(contamination=contamination, random_state=42, n_jobs=-1)
    model.fit(X_scaled)

    scores = model.decision_function(X_scaled)
    labels = model.predict(X_scaled)  # -1 = anomaly, 1 = normal

    result_df = df.loc[X.index].copy()
    result_df["anomaly_score"] = np.round(scores, 4)
    result_df["is_anomaly"] = labels == -1

    return result_df


class AlphaUsersMlJob(SchedulerJob):
    def execute(self, context):
        page_size = int(context["params"].get("pageSize", 200))
        contamination = float(context["params"].get("contamination", 0.05))
        fields = context["params"].get("fields", DEFAULT_FIELDS)

        iga_client = context["iga_client"]

        # 1. Fetch all alpha users via the IGA Scheduler SDK.
        users = fetch_all_users(iga_client, page_size, fields)
        total_fetched = len(users)

        if total_fetched == 0:
            return {
                "status": "no_users_found",
                "totalFetched": 0,
                "anomalyCount": 0,
                "flaggedUsers": [],
                "summary": {},
            }

        # 2. Build feature matrix.
        df = build_feature_matrix(users)

        # 3. Run IsolationForest anomaly detection.
        result_df = run_anomaly_detection(df, contamination)
        anomalies = result_df[result_df["is_anomaly"]]

        # 4. Assemble output — only anomalous accounts returned in full detail.
        flagged = anomalies[["_id", "userName", "anomaly_score",
                              "role_count", "group_count",
                              "days_since_sync", "is_disabled"]] \
            .sort_values("anomaly_score") \
            .to_dict(orient="records")

        feature_cols = ["account_age_days", "days_since_sync",
                        "role_count", "group_count", "is_disabled"]
        numeric = result_df[feature_cols]
        summary = {
            col: {
                "mean": round(float(numeric[col].mean()), 2),
                "std": round(float(numeric[col].std()), 2),
                "max": round(float(numeric[col].max()), 2),
            }
            for col in feature_cols
        }

        return {
            "status": "completed",
            "totalFetched": total_fetched,
            "anomalyCount": int(len(anomalies)),
            "flaggedUsers": flagged,
            "summary": summary,
        }


run_job(AlphaUsersMlJob)
