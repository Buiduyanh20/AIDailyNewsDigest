import { ValidationError } from "../errors/index.js";
import type { JobQueue } from "../queue/job-queue.js";
import type { SourceService } from "./service.js";

export const SOURCE_COLLECTION_QUEUE = "collect-source";

type SourceCollectionJob = {
  sourceId: string;
};

export async function registerSourceCollectionWorker(queue: JobQueue, sourceService: SourceService): Promise<void> {
  await queue.work<SourceCollectionJob>(SOURCE_COLLECTION_QUEUE, async (data) => {
    if (!data || typeof data.sourceId !== "string" || !data.sourceId) {
      throw new ValidationError("The collection job payload is invalid.");
    }

    await sourceService.collectSource(data.sourceId);
  });
}
