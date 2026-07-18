import pytest
from unittest.mock import MagicMock, patch

from iga_scheduler.iga_client import BrokerIgaClient, DirectIgaClient, resolve_iga_client


def make_broker_client(monkeypatch):
    monkeypatch.setenv("IGA_BROKER_URL", "https://broker.example.com")
    monkeypatch.setenv("IGA_SCHEDULER_RUN_ID", "run-123")
    return BrokerIgaClient()


def make_direct_client(monkeypatch):
    monkeypatch.setenv("IGA_BASE_URL", "https://iga.example.com")
    monkeypatch.setenv("IGA_TOKEN_ENDPOINT", "https://token.example.com/token")
    monkeypatch.setenv("IGA_CLIENT_ID", "cid")
    monkeypatch.setenv("IGA_CLIENT_SECRET", "csec")
    return DirectIgaClient()


class TestBrokerIgaClient:
    def test_execute_posts_to_broker_with_token(self, monkeypatch):
        client = make_broker_client(monkeypatch)
        client._token = "tok"
        client._token_exp = 9999999999

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"requestId": "req-1"}

        with patch("iga_scheduler.iga_client.requests.post", return_value=mock_resp) as mock_post:
            result = client.execute("POST", "/scheduler/risk-scores/recompute", {"key": "val"})

        mock_post.assert_called_once_with(
            "https://broker.example.com",
            json={"runId": "run-123", "dispatchId": None, "method": "POST", "path": "/scheduler/risk-scores/recompute", "body": {"key": "val"}},
            headers={"Authorization": "Bearer tok"},
            timeout=30,
        )
        assert result == {"requestId": "req-1"}

    def test_execute_includes_dispatch_id_when_set(self, monkeypatch):
        monkeypatch.setenv("IGA_SCHEDULER_DISPATCH_ID", "dispatch-abc")
        client = make_broker_client(monkeypatch)
        client._token = "tok"
        client._token_exp = 9999999999

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"requestId": "req-1"}

        with patch("iga_scheduler.iga_client.requests.post", return_value=mock_resp) as mock_post:
            client.execute("GET", "/scheduler/risk-scores", None)

        mock_post.assert_called_once_with(
            "https://broker.example.com",
            json={"runId": "run-123", "dispatchId": "dispatch-abc", "method": "GET", "path": "/scheduler/risk-scores", "body": None},
            headers={"Authorization": "Bearer tok"},
            timeout=30,
        )

    def test_execute_retries_once_on_401(self, monkeypatch):
        client = make_broker_client(monkeypatch)
        client._token = "old-tok"
        client._token_exp = 9999999999

        first_resp = MagicMock()
        first_resp.status_code = 401

        new_token_resp = MagicMock()
        new_token_resp.text = "new-tok"
        new_token_resp.status_code = 200

        second_resp = MagicMock()
        second_resp.status_code = 200
        second_resp.json.return_value = {"ok": True}

        with patch("iga_scheduler.iga_client.requests.post", side_effect=[first_resp, second_resp]) as mock_post, \
             patch("iga_scheduler.iga_client.requests.get", return_value=new_token_resp):
            result = client.execute("POST", "/path", None)

        assert mock_post.call_count == 2
        assert result == {"ok": True}

    def test_execute_does_not_retry_second_401(self, monkeypatch):
        client = make_broker_client(monkeypatch)
        client._token = "old-tok"
        client._token_exp = 9999999999

        first_resp = MagicMock()
        first_resp.status_code = 401

        new_token_resp = MagicMock()
        new_token_resp.text = "new-tok"
        new_token_resp.status_code = 200

        second_resp = MagicMock()
        second_resp.status_code = 401
        second_resp.raise_for_status.side_effect = Exception("401 again")

        with patch("iga_scheduler.iga_client.requests.post", side_effect=[first_resp, second_resp]), \
             patch("iga_scheduler.iga_client.requests.get", return_value=new_token_resp):
            with pytest.raises(Exception, match="401 again"):
                client.execute("POST", "/path", None)


class TestDirectIgaClient:
    def test_execute_calls_iga_base_url_with_token(self, monkeypatch):
        client = make_direct_client(monkeypatch)
        client._token = "direct-tok"
        client._token_exp = 9999999999

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"data": "result"}

        with patch("iga_scheduler.iga_client.requests.request", return_value=mock_resp) as mock_req:
            result = client.execute("GET", "/info/ping")

        mock_req.assert_called_once_with(
            "GET",
            "https://iga.example.com/info/ping",
            json=None,
            headers={"Authorization": "Bearer direct-tok"},
            timeout=30,
        )
        assert result == {"data": "result"}


class TestResolveIgaClient:
    def test_returns_broker_when_broker_url_set(self, monkeypatch):
        monkeypatch.setenv("IGA_BROKER_URL", "https://broker.example.com")
        monkeypatch.setenv("IGA_SCHEDULER_RUN_ID", "run-1")
        monkeypatch.delenv("IGA_BASE_URL", raising=False)
        client = resolve_iga_client()
        assert isinstance(client, BrokerIgaClient)

    def test_returns_direct_when_only_base_url_set(self, monkeypatch):
        monkeypatch.delenv("IGA_BROKER_URL", raising=False)
        monkeypatch.setenv("IGA_BASE_URL", "https://iga.example.com")
        monkeypatch.setenv("IGA_TOKEN_ENDPOINT", "https://token.example.com/token")
        monkeypatch.setenv("IGA_CLIENT_ID", "cid")
        monkeypatch.setenv("IGA_CLIENT_SECRET", "csec")
        client = resolve_iga_client()
        assert isinstance(client, DirectIgaClient)

    def test_raises_when_neither_set(self, monkeypatch):
        monkeypatch.delenv("IGA_BROKER_URL", raising=False)
        monkeypatch.delenv("IGA_BASE_URL", raising=False)
        with pytest.raises(RuntimeError, match="no IGA client configured"):
            resolve_iga_client()
