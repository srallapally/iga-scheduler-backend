import base64
import json
import os
import time

import requests


class BrokerIgaClient:
    def __init__(self):
        self._broker_url = os.environ["IGA_BROKER_URL"]
        self._run_id = os.environ.get("IGA_SCHEDULER_RUN_ID")
        self._dispatch_id = os.environ.get("IGA_SCHEDULER_DISPATCH_ID")
        self._token = None
        self._token_exp = 0

    def _fetch_token(self):
        metadata_url = (
            "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts"
            f"/default/identity?audience={self._broker_url}&format=full"
        )
        resp = requests.get(metadata_url, headers={"Metadata-Flavor": "Google"}, timeout=10)
        resp.raise_for_status()
        token = resp.text.strip()
        try:
            payload_b64 = token.split(".")[1]
            padded = payload_b64 + "=" * (-len(payload_b64) % 4)
            payload = json.loads(base64.urlsafe_b64decode(padded))
            self._token_exp = payload.get("exp", 0)
        except Exception:
            self._token_exp = time.time() + 3600
        self._token = token

    def _get_token(self):
        if not self._token or time.time() >= self._token_exp - 60:
            self._fetch_token()
        return self._token

    def execute(self, method, path, body=None):
        token = self._get_token()
        resp = requests.post(
            self._broker_url,
            json={"runId": self._run_id, "dispatchId": self._dispatch_id, "method": method, "path": path, "body": body},
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        if resp.status_code == 401:
            self._token = None
            token = self._get_token()
            resp = requests.post(
                self._broker_url,
                json={"runId": self._run_id, "dispatchId": self._dispatch_id, "method": method, "path": path, "body": body},
                headers={"Authorization": f"Bearer {token}"},
                timeout=30,
            )
        resp.raise_for_status()
        return resp.json()


class DirectIgaClient:
    def __init__(self):
        self._base_url = os.environ["IGA_BASE_URL"]
        self._token_endpoint = os.environ["IGA_TOKEN_ENDPOINT"]
        self._client_id = os.environ["IGA_CLIENT_ID"]
        self._client_secret = os.environ["IGA_CLIENT_SECRET"]
        self._token = None
        self._token_exp = 0

    def _fetch_token(self):
        resp = requests.post(
            self._token_endpoint,
            data={
                "grant_type": "client_credentials",
                "client_id": self._client_id,
                "client_secret": self._client_secret,
            },
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        self._token = data["access_token"]
        expires_in = data.get("expires_in", 3600)
        self._token_exp = time.time() + expires_in

    def _get_token(self):
        if not self._token or time.time() >= self._token_exp - 60:
            self._fetch_token()
        return self._token

    def execute(self, method, path, body=None):
        token = self._get_token()
        url = f"{self._base_url.rstrip('/')}{path}"
        resp = requests.request(
            method,
            url,
            json=body,
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()


def resolve_iga_client():
    if os.environ.get("IGA_BROKER_URL"):
        return BrokerIgaClient()
    if os.environ.get("IGA_BASE_URL"):
        return DirectIgaClient()
    raise RuntimeError(
        "no IGA client configured: set IGA_BROKER_URL (production) or IGA_BASE_URL (local)"
    )
