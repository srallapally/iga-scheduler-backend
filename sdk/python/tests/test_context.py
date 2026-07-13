import json
import os
import tempfile

import pytest

from iga_scheduler.context import ParameterReader, create_context


def make_context_file(data):
    f = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
    json.dump(data, f)
    f.close()
    return f.name


def test_parameter_reader_required_string():
    r = ParameterReader({"key": "value"})
    assert r.required_string("key") == "value"


def test_parameter_reader_required_string_missing():
    r = ParameterReader({})
    with pytest.raises(ValueError, match="missing required string parameter: key"):
        r.required_string("key")


def test_parameter_reader_required_string_array():
    r = ParameterReader({"apps": ["a", "b"]})
    assert r.required_string_array("apps") == ["a", "b"]


def test_parameter_reader_required_string_array_missing():
    r = ParameterReader({})
    with pytest.raises(ValueError, match="missing required string array parameter: apps"):
        r.required_string_array("apps")


def test_create_context_reads_file(monkeypatch):
    data = {
        "runId": "run-1",
        "definition": {"definitionId": "d1"},
        "instance": {"instanceId": "i1"},
        "scheduledFireTime": "2024-01-01T00:00:00Z",
        "attempt": 2,
        "params": {"window": "PT1H"},
    }
    ctx_file = make_context_file(data)
    monkeypatch.setenv("IGA_SCHEDULER_CONTEXT_FILE", ctx_file)
    monkeypatch.setenv("IGA_BASE_URL", "https://iga.example.com")
    monkeypatch.setenv("IGA_TOKEN_ENDPOINT", "https://token.example.com/token")
    monkeypatch.setenv("IGA_CLIENT_ID", "client-id")
    monkeypatch.setenv("IGA_CLIENT_SECRET", "secret")
    try:
        ctx = create_context()
        assert ctx["run_id"] == "run-1"
        assert ctx["definition"]["definitionId"] == "d1"
        assert ctx["instance"]["instanceId"] == "i1"
        assert ctx["scheduled_fire_time"] == "2024-01-01T00:00:00Z"
        assert ctx["attempt"] == 2
        assert ctx["params"]["window"] == "PT1H"
        assert ctx["param"].required_string("window") == "PT1H"
        assert ctx["iga_client"] is not None
    finally:
        os.unlink(ctx_file)


def test_create_context_raises_without_env(monkeypatch):
    monkeypatch.delenv("IGA_SCHEDULER_CONTEXT_FILE", raising=False)
    with pytest.raises(RuntimeError, match="IGA_SCHEDULER_CONTEXT_FILE is not set"):
        create_context()
