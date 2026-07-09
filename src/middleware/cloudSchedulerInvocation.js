export const CLOUD_SCHEDULER_SOURCE_HEADER = "x-iga-scheduler-source";
export const CLOUD_SCHEDULER_SOURCE_VALUE = "cloud-scheduler";

export function requireCloudSchedulerInvocation({
  headerName = CLOUD_SCHEDULER_SOURCE_HEADER,
  headerValue = CLOUD_SCHEDULER_SOURCE_VALUE
} = {}) {
  return (req, res, next) => {
    if (req.get(headerName) !== headerValue) {
      return res.status(401).json({
        error: "unauthorized scheduler invocation"
      });
    }

    return next();
  };
}
