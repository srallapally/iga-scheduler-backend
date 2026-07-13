from iga_scheduler import SchedulerJob, run_job


class RiskScoreJob(SchedulerJob):
    def execute(self, context):
        scan_type = context["param"].required_string("scanType")
        applications = context["param"].required_string_array("applications")
        response = context["iga_client"].execute(
            "POST",
            "/scheduler/risk-scores/recompute",
            {"scanType": scan_type, "applications": applications},
        )
        return {"status": "submitted", "igaRequestId": response.get("requestId")}


run_job(RiskScoreJob)
