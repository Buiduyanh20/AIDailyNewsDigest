import { ValidationError } from "../errors/index.js";
import type { JobQueue } from "../queue/job-queue.js";
import type { ArticleProcessor } from "./processor.js";

export const ARTICLE_PROCESSING_QUEUE = "process-article";

type ArticleProcessingJob = {
  articleId: string;
};

/**
 * pg-boss handler for process-article. AI failures are persisted on the
 * Article (processing_status = failed) instead of being thrown, so pg-boss
 * never retries endlessly; retries are bounded inside the processor and can be
 * requested again through the retry API.
 */
export async function registerArticleProcessingWorker(queue: JobQueue, processor: ArticleProcessor): Promise<void> {
  await queue.work<ArticleProcessingJob>(ARTICLE_PROCESSING_QUEUE, async (data) => {
    if (!data || typeof data.articleId !== "string" || !data.articleId) {
      throw new ValidationError("The process-article job payload is invalid.");
    }
    await processor.process(data.articleId);
  });
}

export function enqueueArticleProcessing(queue: JobQueue, articleId: string): Promise<string | null> {
  // Duplicate jobs are safe: the handler claims the Article atomically and skips processed ones.
  return queue.enqueue(ARTICLE_PROCESSING_QUEUE, { articleId }, { retryLimit: 0 });
}
