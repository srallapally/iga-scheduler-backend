import { createEsClient } from "../src/clients/esClient.js";
import { getSchedulerIndexDefinitions } from "../src/elasticsearch/schedulerIndexMappings.js";

async function bootstrap({ esClient = createEsClient(), dryRun = process.argv.includes("--dry-run") } = {}) {
  const indices = getSchedulerIndexDefinitions();
  for (const { name, body } of indices) {
    const exists = await esClient.indices.exists({ index: name });
    if (exists) {
      console.log(`[skip] ${name} already exists`);
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] would create ${name}`);
      continue;
    }
    await esClient.indices.create({ index: name, ...body });
    console.log(`[created] ${name}`);
  }
}

bootstrap().catch((err) => { console.error(err); process.exit(1); });
