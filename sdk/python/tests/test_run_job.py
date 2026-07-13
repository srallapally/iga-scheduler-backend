import json
import os
import tempfile

import pytest

from iga_scheduler.scheduler_job import SchedulerJob


def make_context_file(data):
    f = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
    json.dump(data, f)
    f.close()
    return f.name


def test_run_job_prints_result_and_exits_zero(monkeypatch, capsys):
    ctx_file = make_context_file({"runId": "run-1", "params": {}})
    monkeypatch.setenv("IGA_SCHEDULER_CONTEXT_FILE", ctx_file)
    monkeypatch.setenv("IGA_BASE_URL", "https://iga.example.com")
    monkeypatch.setenv("IGA_TOKEN_ENDPOINT", "https://token.example.com/token")
    monkeypatch.setenv("IGA_CLIENT_ID", "cid")
    monkeypatch.setenv("IGA_CLIENT_SECRET", "csec")

    class SuccessJob(SchedulerJob):
        def execute(self, context):
            return {"status": "ok"}

    from iga_scheduler.run_job import run_job

    with pytest.raises(SystemExit) as exc_info:
        run_job(SuccessJob)

    assert exc_info.value.code == 0
    captured = capsys.readouterr()
    assert "IGA_RESULT_JSON:" in captured.out
    payload = json.loads(captured.out.strip().split("IGA_RESULT_JSON:")[1])
    assert payload == {"status": "ok"}

    os.unlink(ctx_file)


def test_run_job_exits_nonzero_on_exception(monkeypatch, capsys):
    ctx_file = make_context_file({"runId": "run-1", "params": {}})
    monkeypatch.setenv("IGA_SCHEDULER_CONTEXT_FILE", ctx_file)
    monkeypatch.setenv("IGA_BASE_URL", "https://iga.example.com")
    monkeypatch.setenv("IGA_TOKEN_ENDPOINT", "https://token.example.com/token")
    monkeypatch.setenv("IGA_CLIENT_ID", "cid")
    monkeypatch.setenv("IGA_CLIENT_SECRET", "csec")

    class FailingJob(SchedulerJob):
        def execute(self, context):
            raise RuntimeError("job failed")

    from iga_scheduler.run_job import run_job

    with pytest.raises(RuntimeError, match="job failed"):
        run_job(FailingJob)

    os.unlink(ctx_file)
