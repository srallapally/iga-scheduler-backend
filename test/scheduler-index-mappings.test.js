import { describe, expect, it } from "vitest";
import {
  defaultSchedulerIndexNames,
  getSchedulerIndexDefinitions
} from "../src/elasticsearch/schedulerIndexMappings.js";

describe("scheduler index mappings", () => {
  it("exports exactly two index definitions: definitions and audit", () => {
    const indices = getSchedulerIndexDefinitions();
    expect(indices).toHaveLength(2);
    const names = indices.map((i) => i.name);
    expect(names).toContain(defaultSchedulerIndexNames.definitions);
    expect(names).toContain(defaultSchedulerIndexNames.audit);
  });

  it("maps definition index fields", () => {
    const def = getSchedulerIndexDefinitions().find((i) => i.name === defaultSchedulerIndexNames.definitions);
    expect(def.body.mappings.dynamic).toBe(false);
    expect(def.body.mappings.properties.definitionId).toEqual({ type: "keyword" });
    expect(def.body.mappings.properties.state).toEqual({ type: "keyword" });
    expect(def.body.mappings.properties.enabled).toEqual({ type: "boolean" });
  });

  it("maps audit event fields", () => {
    const audit = getSchedulerIndexDefinitions().find((i) => i.name === defaultSchedulerIndexNames.audit);
    expect(audit.body.mappings.dynamic).toBe(false);
    expect(audit.body.mappings.properties.eventType).toEqual({ type: "keyword" });
    expect(audit.body.mappings.properties.targetId).toEqual({ type: "keyword" });
    expect(audit.body.mappings.properties.createdAt).toEqual({ type: "date" });
  });
});
