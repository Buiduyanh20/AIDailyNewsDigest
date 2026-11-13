import { z } from "zod";

import type { EventDetailResponse, EventListQuery, EventListResponse } from "@aidnd/contracts";

import { ConflictError, InfrastructureError, NotFoundError } from "../errors/index.js";
import type { EventReadStore } from "./store.js";

const uuidSchema = z.string().uuid();

export interface EventService {
  listEvents(userId: string, query: EventListQuery): Promise<EventListResponse>;
  getEvent(userId: string, eventId: string): Promise<EventDetailResponse>;
  /** Re-queues AI processing for a pending/failed Article owned by the user. */
  retryArticle(userId: string, articleId: string): Promise<{ jobId: string; status: "queued" }>;
}

export class DefaultEventService implements EventService {
  constructor(
    private readonly store: EventReadStore,
    private readonly enqueueProcessing?: (articleId: string) => Promise<string | null>,
  ) {}

  async listEvents(userId: string, query: EventListQuery): Promise<EventListResponse> {
    const { items, total } = await this.store.listEvents(userId, {
      search: query.search,
      date: query.date,
      sourceId: query.sourceId,
      page: query.page,
      pageSize: query.pageSize,
    });
    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  async getEvent(userId: string, eventId: string): Promise<EventDetailResponse> {
    if (!uuidSchema.safeParse(eventId).success) throw new NotFoundError("The event was not found.");
    const event = await this.store.getEvent(userId, eventId);
    if (!event) throw new NotFoundError("The event was not found.");
    return event;
  }

  async retryArticle(userId: string, articleId: string): Promise<{ jobId: string; status: "queued" }> {
    if (!uuidSchema.safeParse(articleId).success) throw new NotFoundError("The article was not found.");
    const article = await this.store.findArticleForUser(userId, articleId);
    if (!article) throw new NotFoundError("The article was not found.");
    if (article.associated || article.processingStatus === "processed") {
      throw new ConflictError("The article has already been processed.");
    }
    if (article.processingStatus === "processing") {
      throw new ConflictError("The article is already being processed.");
    }
    if (!this.enqueueProcessing) throw new InfrastructureError("The processing queue is not available.");

    const jobId = await this.enqueueProcessing(articleId);
    if (!jobId) throw new InfrastructureError("The processing job could not be queued.");
    return { jobId, status: "queued" };
  }
}

/** Used when no database is configured (unit tests): no Events exist. */
export function createMemoryEventService(): EventService {
  return {
    async listEvents(_userId, query) {
      return { items: [], page: query.page, pageSize: query.pageSize, total: 0 };
    },
    async getEvent() {
      throw new NotFoundError("The event was not found.");
    },
    async retryArticle() {
      throw new NotFoundError("The article was not found.");
    },
  };
}
