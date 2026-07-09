import { z } from "zod";

export const cronScheduleSchema = z.object({
  type: z.literal("cron"),
  expression: z.string().min(1),
  timezone: z.string().min(1).default("UTC")
});

export const stringParameterValueSchema = z.object({
  type: z.literal("string"),
  value: z.string()
});

export const stringArrayParameterValueSchema = z.object({
  type: z.literal("string[]"),
  value: z.array(z.string())
});

export const sensitiveParameterValueSchema = z.object({
  type: z.literal("sensitive"),
  secretRef: z.string().min(1)
}).strict();

export const instanceParameterValueSchema = z.union([
  stringParameterValueSchema,
  stringArrayParameterValueSchema,
  sensitiveParameterValueSchema
]);

export const createJobInstanceSchema = z.object({
  instanceId: z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/),
  enabled: z.boolean().default(true),
  schedule: cronScheduleSchema,
  parameters: z.record(z.string(), instanceParameterValueSchema).default({})
});

export const patchJobInstanceSchema = z.object({
  enabled: z.boolean().optional(),
  schedule: cronScheduleSchema.optional(),
  parameters: z.record(z.string(), instanceParameterValueSchema).optional()
});
