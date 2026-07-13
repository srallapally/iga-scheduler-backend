import json
import sys

from .context import create_context

RESULT_PREFIX = "IGA_RESULT_JSON:"


def run_job(job_class):
    context = create_context()
    job = job_class()
    result = job.execute(context)
    print(f"{RESULT_PREFIX}{json.dumps(result)}", flush=True)
    sys.exit(0)
