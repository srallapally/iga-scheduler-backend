import json
import os

from .iga_client import resolve_iga_client


class ParameterReader:
    def __init__(self, params):
        self._params = params or {}

    def required_string(self, name):
        v = self._params.get(name)
        if not v or not isinstance(v, str):
            raise ValueError(f"missing required string parameter: {name}")
        return v

    def required_string_array(self, name):
        v = self._params.get(name)
        if not isinstance(v, list) or not v:
            raise ValueError(f"missing required string array parameter: {name}")
        return v


def create_context():
    context_file = os.environ.get("IGA_SCHEDULER_CONTEXT_FILE")
    if not context_file:
        raise RuntimeError("IGA_SCHEDULER_CONTEXT_FILE is not set")
    with open(context_file) as f:
        raw = json.load(f)
    return {
        "raw": raw,
        "run_id": raw.get("runId"),
        "definition": raw.get("definition", {}),
        "instance": raw.get("instance", {}),
        "scheduled_fire_time": raw.get("scheduledFireTime"),
        "attempt": raw.get("attempt", 1),
        "params": raw.get("params", {}),
        "param": ParameterReader(raw.get("params")),
        "iga_client": resolve_iga_client(),
    }
