export function getConfig() {
  const required = ["GCP_PROJECT_ID", "JOB_ZIP_BUCKET", "ES_ENDPOINT", "ES_API_KEY"];
  const missing = required.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return {
    gcpProjectId: process.env.GCP_PROJECT_ID,
    jobZipBucket: process.env.JOB_ZIP_BUCKET,
    esEndpoint: process.env.ES_ENDPOINT,
    esApiKey: process.env.ES_API_KEY,
    definitionsIndex: process.env.ES_DEFINITIONS_INDEX || "scheduler_definitions_v1",
    instancesIndex: process.env.ES_INSTANCES_INDEX || "scheduler_instances_v1",
    runsIndex: process.env.ES_RUNS_INDEX || "scheduler_runs_v1",
    auditIndex: process.env.ES_AUDIT_INDEX || "scheduler_audit_v1"
  };
}
