export class SchedulerJob {
    async run(context) {
        context.logger.info("Job started", {
            runId: context.runId,
            definitionId: context.definitionId,
            instanceId: context.instanceId
        });

        await context.audit.event("JOB_STARTED");

        try {
            const result = await this.execute(context);
            await context.audit.event("JOB_SUCCEEDED", { result });
            return result;
        } catch (error) {
            context.logger.error("Job failed", {
                error: error instanceof Error ? error.message : String(error)
            });

            await context.audit.event("JOB_FAILED", {
                error: error instanceof Error ? error.message : String(error)
            });

            throw error;
        }
    }

    async execute(_context) {
        throw new Error("execute(context) must be implemented by the job");
    }
}