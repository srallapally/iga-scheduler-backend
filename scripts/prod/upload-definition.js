#!/usr/bin/env node
// Upload a job definition zip directly via JobDefinitionService (bypasses HTTP auth).
// Usage: node scripts/prod/upload-definition.js <zip-path> <metadata-json>
// Example:
//   node scripts/prod/upload-definition.js /tmp/hello-world-v2.zip \
//     '{"definitionId":"hello-world-v2","name":"Hello World v2","runtime":"javascript","runtimeVersion":"22","wrapperVersion":"1.0.0","entrypoint":"job.js","parameters":[],"timeoutSeconds":60}'

import { readFile } from "fs/promises";
import { JobDefinitionService } from "../../src/services/jobDefinitionService.js";

const [, , zipPath, metadataJson] = process.argv;

if (!zipPath || !metadataJson) {
  console.error("Usage: node scripts/prod/upload-definition.js <zip-path> <metadata-json>");
  process.exit(1);
}

const metadata = JSON.parse(metadataJson);
const artifactBuffer = await readFile(zipPath);

const service = new JobDefinitionService();
const definition = await service.createDefinition({ metadata, artifactBuffer });

console.log(JSON.stringify(definition, null, 2));
