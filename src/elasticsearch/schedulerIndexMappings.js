export const defaultSchedulerIndexNames = { definitions: "scheduler_definitions_v1", audit: "scheduler_audit_v1" };

export function getSchedulerIndexDefinitions({ definitions = defaultSchedulerIndexNames.definitions, audit = defaultSchedulerIndexNames.audit } = {}) {
  return [
    {
      name: definitions,
      body: {
        mappings: {
          dynamic: false,
          properties: {
            definitionId: { type: "keyword" },
            name: { type: "text", fields: { keyword: { type: "keyword" } } },
            runtime: { type: "keyword" },
            runtimeVersion: { type: "keyword" },
            wrapperVersion: { type: "keyword" },
            entrypoint: { type: "keyword" },
            parameters: { type: "object", enabled: false },
            timeoutSeconds: { type: "integer" },
            memoryMb: { type: "integer" },
            version: { type: "integer" },
            state: { type: "keyword" },
            enabled: { type: "boolean" },
            jobZip: { type: "object", enabled: false },
            validation: { type: "object", enabled: false },
            createdAt: { type: "date" },
            updatedAt: { type: "date" }
          }
        }
      }
    },
    {
      name: audit,
      body: {
        mappings: {
          dynamic: false,
          properties: {
            eventId: { type: "keyword" },
            eventType: { type: "keyword" },
            actor: { type: "keyword" },
            targetType: { type: "keyword" },
            targetId: { type: "keyword" },
            outcome: { type: "keyword" },
            createdAt: { type: "date" },
            details: { type: "object", enabled: false }
          }
        }
      }
    }
  ];
}
