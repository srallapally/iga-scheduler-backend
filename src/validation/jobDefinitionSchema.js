import { z } from "zod";

export const jobParameterSchema = z.object({
  name: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  type: z.enum(["string", "string[]", "sensitive"]),
  required: z.boolean().default(false)
});

export const createJobDefinitionSchema = z.object({
  definitionId: z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/),
  name: z.string().min(1),
  runtime: z.enum(["javascript", "python"]),
  runtimeVersion: z.string().min(1),
  wrapperVersion: z.string().min(1),
  entrypoint: z.string().min(1),
  parameters: z.array(jobParameterSchema).default([]),
  timeoutSeconds: z.number().int().min(30).max(3600).default(1800),
  memoryMb: z.number().int().min(64).max(512).optional()
});

export const patchJobDefinitionSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  timeoutSeconds: z.number().int().min(30).max(3600).optional(),
  memoryMb: z.number().int().min(64).max(512).optional()
});
