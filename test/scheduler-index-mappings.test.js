import { describe, expect, it } from "vitest";
import {
  getSchedulerIndexDefinitions,
  getSchedulerIndexPutMappings
} from "../src/elasticsearch/schedulerIndexMappings.js";

describe("scheduler index mappings", () => {
  it("maps scheduler instance fields used by due-instance queries", () => {
    const instances = getSchedulerIndexDefinitions().find((definition) => {
      return definition.name === "scheduler_instances_v1";
    });

    expect(instances.body.mappings.dynamic).toBe(false);
    expect(instances.body.mappings.properties.enabled).toEqual({ type: "boolean" });
    expect(instances.body.mappings.properties.state).toEqual({ type: "keyword" });
    expect(instances.body.mappings.properties.nextFireAt).toEqual({ type: "date" });
  });

  it("maps the persisted cron schedule shape", () => {
    const instances = getSchedulerIndexDefinitions().find((definition) => {
      return definition.name === "scheduler_instances_v1";
    });

    expect(instances.body.mappings.properties.schedule.properties).toEqual({
      type: { type: "keyword" },
      expression: { type: "keyword" },
      timezone: { type: "keyword" }
    });
  });

  it("maps audit event fields used by audit queries", () => {
    const audit = getSchedulerIndexDefinitions().find((definition) => {
      return definition.name === "scheduler_audit_v1";
    });

    expect(audit.body.mappings.dynamic).toBe(false);
    expect(audit.body.mappings.properties.eventType).toEqual({ type: "keyword" });
    expect(audit.body.mappings.properties.targetId).toEqual({ type: "keyword" });
    expect(audit.body.mappings.properties.createdAt).toEqual({ type: "date" });
  });

  it("builds mapping updates for existing indices", () => {
    const mappings = getSchedulerIndexPutMappings();
    const instanceMapping = mappings.find((mapping) => {
      return mapping.name === "scheduler_instances_v1";
    });
    const auditMapping = mappings.find((mapping) => {
      return mapping.name === "scheduler_audit_v1";
    });

    expect(instanceMapping.body.properties.state).toEqual({ type: "keyword" });
    expect(instanceMapping.body.properties.schedule.properties.expression).toEqual({ type: "keyword" });
    expect(auditMapping.body.properties.createdAt).toEqual({ type: "date" });
    expect(auditMapping.body.properties.eventType).toEqual({ type: "keyword" });
    expect(auditMapping.body.properties.details).toEqual({ type: "object", enabled: false });
  });
});
