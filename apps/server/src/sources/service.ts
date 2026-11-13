import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Pool } from "pg";

import { isLateArrival, resolveArticleLanguage, type Article, type Source } from "@aidnd/domain";

import { environment } from "../config/env.js";
import { type ArticleRepository, type SourceRepository, createPostgresRepositories } from "../db/repositories.js";
import { AppError, InfrastructureError, NotFoundError, ValidationError } from "../errors/index.js";

export type SourceListQuery = {
  page?: number;
  pageSize?: number;
  status?: Source["status"];
  search?: string;
};

export type SourcePatch = Partial<Pick<Source, "name" | "websiteUrl" | "rssUrl" | "enabled">>;

export type SourceServiceDependencies = {
  sources: SourceRepository;
  articles: ArticleRepository;
  enqueueCollection?: (sourceId: string) => Promise<string | null>;
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_FEED_BYTES = 1_048_576;
const VALID_CONTENT_TYPES = [
  "application/rss+xml",
  "application/atom+xml",
  "application/xml",
  "text/xml",
  "application/x-rss+xml",
];

function normalizeUrl(rawUrl: string): string | null {
  try {
    const value = new URL(rawUrl);
    value.hash = "";
    value.username = "";
    value.password = "";
    if (value.protocol !== "http:" && value.protocol !== "https:") return null;
    value.hostname = value.hostname.toLowerCase();
    if (value.port === "80" && value.protocol === "http:") value.port = "";
    if (value.port === "443" && value.protocol === "https:") value.port = "";
    return value.toString();
  } catch {
    return null;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a === 169 || a === 224 || a === 225 || a === 240 || a === 255) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if ((a === 198 && b === 18) || (a === 198 && b === 51 && c === 100)) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80") || normalized.startsWith("::ffff:") || normalized.startsWith("::") || normalized.startsWith("2001:db8");
}

async function validateUrl(rawUrl: string, allowLocalhost = false): Promise<string> {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) {
    throw new ValidationError("RSS URL must be a valid http or https URL.");
  }
  const parsed = new URL(normalized);
  const hostname = normalizeHostname(parsed.hostname);
  if (!allowLocalhost && (hostname === "localhost" || hostname.endsWith(".localhost"))) {
    throw new ValidationError("Location is not allowed.");
  }
  if (parsed.username || parsed.password) {
    throw new ValidationError("Credentials are not allowed in RSS URLs.");
  }

  const addresses = await dnsLookup(hostname, { all: true }).catch(() => [] as { address: string }[]);
  for (const entry of addresses) {
    const family = isIP(entry.address);
    if (family === 4 && isBlockedIPv4(entry.address)) {
      throw new ValidationError("RSS URL resolves to a blocked address.");
    }
    if (family === 6 && isBlockedIPv6(entry.address)) {
      throw new ValidationError("RSS URL resolves to a blocked address.");
    }
  }

  return normalized;
}

function sanitizeText(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function getJstDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function extractTagValue(xml: string, tagNames: string[]): string | null {
  for (const tagName of tagNames) {
    const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
    const match = pattern.exec(xml);
    if (match) {
      return sanitizeText(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
    }
  }
  return null;
}

function parseFeedEntries(feedXml: string): Array<{
  title: string;
  url: string | null;
  externalId: string | null;
  excerpt: string | null;
  content: string | null;
  publishedAt: string | null;
}> {
  const itemRegex = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  const entries: Array<{ title: string; url: string | null; externalId: string | null; excerpt: string | null; content: string | null; publishedAt: string | null; }> = [];

  for (const match of feedXml.matchAll(itemRegex)) {
    const block = match[1];
    const title = sanitizeText(extractTagValue(block, ["title"])) ?? "Untitled article";
    const hrefMatch = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i) ?? block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const url = hrefMatch ? sanitizeText(hrefMatch[1] ?? hrefMatch[0]) : null;
    const externalId = sanitizeText(extractTagValue(block, ["guid", "id"])) ?? null;
    const excerpt = sanitizeText(extractTagValue(block, ["description", "summary"])) ?? null;
    const content = sanitizeText(extractTagValue(block, ["content:encoded", "content"])) ?? excerpt;
    const publishedAt = parseDate(sanitizeText(extractTagValue(block, ["pubDate", "published", "updated"])) ?? undefined);
    entries.push({ title, url: url ? normalizeUrl(url) : null, externalId, excerpt, content, publishedAt });
  }

  if (entries.length === 0) {
    const title = sanitizeText(extractTagValue(feedXml, ["title"])) ?? "Untitled article";
    entries.push({
      title,
      url: sanitizeText(extractTagValue(feedXml, ["link"])) ?? null,
      externalId: sanitizeText(extractTagValue(feedXml, ["guid", "id"])) ?? null,
      excerpt: sanitizeText(extractTagValue(feedXml, ["description", "summary"])) ?? null,
      content: sanitizeText(extractTagValue(feedXml, ["content", "description", "summary"])) ?? null,
      publishedAt: parseDate(sanitizeText(extractTagValue(feedXml, ["pubDate", "published", "updated"])) ?? undefined),
    });
  }

  return entries;
}

/**
 * Feed-level language metadata: RSS <language>/<dc:language> in the channel
 * header, or Atom's xml:lang on the root element. Item bodies are not searched.
 */
export function extractFeedLanguage(feedXml: string): string | null {
  const firstItem = feedXml.search(/<(?:item|entry)\b/i);
  const header = firstItem >= 0 ? feedXml.slice(0, firstItem) : feedXml;
  const declared = extractTagValue(header, ["language", "dc:language"]);
  if (declared) return declared;
  return /<(?:feed|rss|rdf:RDF)\b[^>]*\sxml:lang=["']([^"']+)["']/i.exec(header)?.[1] ?? null;
}

function getContentType(rawType: string | null | undefined): string | null {
  if (!rawType) return null;
  return rawType.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

function fingerprintArticle(title: string, excerpt: string | null, url: string | null): string {
  return createHash("sha256").update(`${title}|${excerpt ?? ""}|${url ?? ""}`).digest("hex");
}

class MemorySourceStore {
  readonly sources = new Map<string, Source>();
  readonly articles = new Map<string, Article>();

  createSource(input: { userId: string; name: string; websiteUrl: string; rssUrl?: string | null; enabled?: boolean }): Source {
    const now = new Date().toISOString();
    const source: Source = {
      id: randomUUID(),
      userId: input.userId,
      name: input.name,
      websiteUrl: input.websiteUrl,
      rssUrl: input.rssUrl ?? null,
      enabled: input.enabled ?? true,
      status: "active",
      lastFetchedAt: null,
      lastErrorCode: null,
      lastErrorAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.sources.set(source.id, source);
    return { ...source };
  }

  findByIdForUser(id: string, userId: string): Source | null {
    const source = this.sources.get(id);
    if (!source || source.userId !== userId || source.deletedAt) return null;
    return { ...source };
  }

  listByUser(userId: string): Source[] {
    return Array.from(this.sources.values())
      .filter((source) => source.userId === userId && !source.deletedAt)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  listForUser(userId: string, query: SourceListQuery = {}): { items: Source[]; total: number } {
    const items = this.listByUser(userId).filter((source) => {
      if (query.status && source.status !== query.status) return false;
      const search = (query.search ?? "").trim().toLowerCase();
      if (!search) return true;
      return source.name.toLowerCase().includes(search) || new URL(source.websiteUrl).hostname.toLowerCase().includes(search);
    });
    const page = Math.max(1, Number(query.page ?? 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.pageSize ?? DEFAULT_PAGE_SIZE)));
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length };
  }

  updateSource(id: string, userId: string, patch: SourcePatch): Source | null {
    const current = this.sources.get(id);
    if (!current || current.userId !== userId || current.deletedAt) return null;
    const updated: Source = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.sources.set(id, updated);
    return { ...updated };
  }

  markCollectionSucceeded(id: string, fetchedAt: string): Source | null {
    const current = this.sources.get(id);
    if (!current || !current.enabled || current.deletedAt) return null;
    const updated: Source = {
      ...current,
      status: "active",
      lastFetchedAt: fetchedAt,
      lastErrorCode: null,
      lastErrorAt: null,
      updatedAt: fetchedAt,
    };
    this.sources.set(id, updated);
    return { ...updated };
  }

  markCollectionFailed(id: string, errorCode: string, errorAt: string): Source | null {
    const current = this.sources.get(id);
    if (!current || !current.enabled || current.deletedAt) return null;
    const updated: Source = {
      ...current,
      status: "error",
      lastErrorCode: errorCode,
      lastErrorAt: errorAt,
      updatedAt: errorAt,
    };
    this.sources.set(id, updated);
    return { ...updated };
  }

  softDelete(id: string, userId: string): Source | null {
    const current = this.sources.get(id);
    if (!current || current.userId !== userId || current.deletedAt) return null;
    const updated: Source = { ...current, enabled: false, status: "disabled", deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.sources.set(id, updated);
    return { ...updated };
  }

  createArticle(input: {
    sourceId: string;
    originalUrl: string;
    originalTitle: string;
    externalId?: string | null;
    canonicalUrl?: string | null;
    originalLanguage?: string | null;
    originalExcerpt?: string | null;
    originalContent?: string | null;
    publishedAt?: string | null;
    publishedDateJst?: string | null;
    discoveredAt?: string;
    processingStatus?: string;
    processingErrorCode?: string | null;
    lateArrival?: boolean;
    missedDigestCutoff?: boolean;
  }): Article {
    const now = new Date().toISOString();
    const article: Article = {
      id: randomUUID(),
      sourceId: input.sourceId,
      externalId: input.externalId ?? null,
      canonicalUrl: input.canonicalUrl ?? null,
      originalUrl: input.originalUrl,
      originalTitle: input.originalTitle,
      originalLanguage: input.originalLanguage ?? null,
      originalExcerpt: input.originalExcerpt ?? null,
      originalContent: input.originalContent ?? null,
      publishedAt: input.publishedAt ?? null,
      publishedDateJst: input.publishedDateJst ?? null,
      discoveredAt: input.discoveredAt ?? now,
      processingStatus: input.processingStatus ?? "pending",
      processingErrorCode: input.processingErrorCode ?? null,
      lateArrival: input.lateArrival ?? false,
      missedDigestCutoff: input.missedDigestCutoff ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.articles.set(article.id, article);
    return { ...article };
  }

  listBySource(sourceId: string): Article[] {
    return Array.from(this.articles.values())
      .filter((article) => article.sourceId === sourceId)
      .sort((a, b) => (a.discoveredAt < b.discoveredAt ? 1 : -1));
  }

  findBySourceAndCandidate(sourceId: string, candidate: { canonicalUrl?: string | null; externalId?: string | null; fingerprint?: string | null }): Article | null {
    for (const article of this.listBySource(sourceId)) {
      if (candidate.canonicalUrl && article.canonicalUrl && article.canonicalUrl === candidate.canonicalUrl) return article;
      if (candidate.externalId && article.externalId && article.externalId === candidate.externalId) return article;
      if (candidate.fingerprint) {
        const hash = fingerprintArticle(article.originalTitle, article.originalExcerpt, article.canonicalUrl ?? article.originalUrl);
        if (hash === candidate.fingerprint) return article;
      }
    }
    return null;
  }
}

class MemorySourceRepository implements SourceRepository {
  constructor(private readonly store: MemorySourceStore) {}

  async create(input: { userId: string; name: string; websiteUrl: string; rssUrl?: string | null; enabled?: boolean }): Promise<Source> {
    return this.store.createSource(input);
  }

  async findById(id: string): Promise<Source | null> {
    return this.store.sources.get(id) ?? null;
  }

  async findByIdForUser(id: string, userId: string): Promise<Source | null> {
    return this.store.findByIdForUser(id, userId);
  }

  async listByUser(userId: string): Promise<Source[]> {
    return this.store.listByUser(userId);
  }

  async softDelete(id: string, userId: string): Promise<Source | null> {
    return this.store.softDelete(id, userId);
  }

  async markCollectionSucceeded(id: string, fetchedAt: string): Promise<Source | null> {
    return this.store.markCollectionSucceeded(id, fetchedAt);
  }

  async markCollectionFailed(id: string, errorCode: string, errorAt: string): Promise<Source | null> {
    return this.store.markCollectionFailed(id, errorCode, errorAt);
  }

  async update(id: string, userId: string, patch: SourcePatch): Promise<Source | null> {
    return this.store.updateSource(id, userId, patch);
  }

  async listForUser(userId: string, query: SourceListQuery = {}): Promise<{ items: Source[]; total: number }> {
    return this.store.listForUser(userId, query);
  }
}

class MemoryArticleRepository implements ArticleRepository {
  constructor(private readonly store: MemorySourceStore) {}

  async create(input: {
    sourceId: string;
    originalUrl: string;
    originalTitle: string;
    externalId?: string | null;
    canonicalUrl?: string | null;
    originalLanguage?: string | null;
    originalExcerpt?: string | null;
    originalContent?: string | null;
    publishedAt?: string | null;
    publishedDateJst?: string | null;
    discoveredAt?: string;
    processingStatus?: string;
    processingErrorCode?: string | null;
    lateArrival?: boolean;
    missedDigestCutoff?: boolean;
  }): Promise<Article> {
    return this.store.createArticle(input);
  }

  async findById(id: string): Promise<Article | null> {
    return this.store.articles.get(id) ?? null;
  }

  async listBySource(sourceId: string): Promise<Article[]> {
    return this.store.listBySource(sourceId);
  }

  async findBySourceAndCandidate(sourceId: string, candidate: { canonicalUrl?: string | null; externalId?: string | null; fingerprint?: string | null }): Promise<Article | null> {
    return this.store.findBySourceAndCandidate(sourceId, candidate);
  }
}

export function createMemorySourceService(enqueueCollection?: (sourceId: string) => Promise<string | null>): SourceService {
  const store = new MemorySourceStore();
  return new SourceService({
    sources: new MemorySourceRepository(store),
    articles: new MemoryArticleRepository(store),
    enqueueCollection,
  });
}

export class SourceService {
  constructor(private readonly deps: SourceServiceDependencies) {}

  async createSource(userId: string, input: { name: string; websiteUrl: string; rssUrl?: string | null; enabled?: boolean }): Promise<Source> {
    const name = input.name.trim();
    if (!name) throw new ValidationError("Source name is required.");
    const websiteUrl = normalizeUrl(input.websiteUrl);
    if (!websiteUrl) throw new ValidationError("websiteUrl must be a valid http or https URL.");
    const rssUrl = input.rssUrl ? await validateUrl(input.rssUrl) : null;
    return this.deps.sources.create({ userId, name, websiteUrl, rssUrl, enabled: input.enabled ?? true });
  }

  async listSources(userId: string, query: SourceListQuery = {}): Promise<{ items: Source[]; page: number; pageSize: number; total: number }> {
    const page = Math.max(1, Number(query.page ?? 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.pageSize ?? DEFAULT_PAGE_SIZE)));

    if (this.deps.sources.listForUser) {
      const result = await this.deps.sources.listForUser(userId, { page, pageSize, status: query.status, search: query.search });
      return { items: result.items, page, pageSize, total: result.total };
    }

    const items = (await this.deps.sources.listByUser(userId)).filter((source) => {
      if (query.status && source.status !== query.status) return false;
      const search = (query.search ?? "").trim().toLowerCase();
      if (!search) return true;
      return source.name.toLowerCase().includes(search) || new URL(source.websiteUrl).hostname.toLowerCase().includes(search);
    });

    return { items: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: items.length };
  }

  async getSourceForUser(userId: string, sourceId: string): Promise<{ source: Source; recentArticles: Article[] }> {
    const source = await this.deps.sources.findByIdForUser(sourceId, userId);
    if (!source) throw new NotFoundError("The source was not found.");
    return { source, recentArticles: (await this.deps.articles.listBySource(sourceId)).slice(0, 10) };
  }

  async updateSourceForUser(userId: string, sourceId: string, patch: SourcePatch): Promise<Source> {
    const current = await this.deps.sources.findByIdForUser(sourceId, userId);
    if (!current) throw new NotFoundError("The source was not found.");

    const nextPatch: SourcePatch = { ...patch };
    if (nextPatch.websiteUrl) {
      const normalized = normalizeUrl(nextPatch.websiteUrl);
      if (!normalized) throw new ValidationError("websiteUrl must be a valid http or https URL.");
      nextPatch.websiteUrl = normalized;
    }
    if (nextPatch.rssUrl !== undefined) {
      nextPatch.rssUrl = nextPatch.rssUrl === null ? null : await validateUrl(nextPatch.rssUrl);
    }

    const updated = await this.deps.sources.update?.(sourceId, userId, nextPatch);
    if (!updated) throw new NotFoundError("The source was not found.");
    return updated;
  }

  async deleteSourceForUser(userId: string, sourceId: string): Promise<Source> {
    const current = await this.deps.sources.findByIdForUser(sourceId, userId);
    if (!current) throw new NotFoundError("The source was not found.");
    const deleted = await this.deps.sources.softDelete(sourceId, userId);
    if (!deleted) throw new NotFoundError("The source was not found.");
    return deleted;
  }

  async retrySource(userId: string, sourceId: string): Promise<{ jobId: string; status: "queued" }> {
    const source = await this.deps.sources.findByIdForUser(sourceId, userId);
    if (!source) throw new NotFoundError("The source was not found.");
    if (!source.enabled) throw new ValidationError("Enable this source before retrying collection.");
    if (!source.rssUrl) throw new ValidationError("This source does not have an RSS URL configured.");
    if (!this.deps.enqueueCollection) {
      throw new InfrastructureError("The collection queue is not available.");
    }

    const jobId = await this.deps.enqueueCollection(sourceId);
    if (!jobId) {
      throw new InfrastructureError("The collection job could not be queued.");
    }
    return { jobId, status: "queued" };
  }

  async collectSource(sourceId: string): Promise<{ new: number; duplicate: number; failed: number }> {
    const source = this.deps.sources.findById ? await this.deps.sources.findById(sourceId) : null;
    if (!source) throw new NotFoundError("The source was not found.");
    if (!source.enabled || source.deletedAt) return { new: 0, duplicate: 0, failed: 0 };
    try {
      if (!source.rssUrl) throw new ValidationError("This source does not have an RSS URL configured.");

      const response = await fetch(source.rssUrl, {
        headers: { "user-agent": "AI-Daily-News-Digest/1.0" },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status >= 300 && response.status < 400) throw new ValidationError("RSS redirect is blocked.");
      if (!response.ok) throw new ValidationError(`RSS fetch failed with HTTP ${response.status}.`);

      const contentType = getContentType(response.headers.get("content-type"));
      if (contentType && !VALID_CONTENT_TYPES.includes(contentType)) throw new ValidationError("RSS content type is not supported.");

      const feedText = await response.text();
      if (feedText.length > MAX_FEED_BYTES) throw new ValidationError("RSS feed exceeds the configured size limit.");

      const feedLanguage = extractFeedLanguage(feedText);
      let newCount = 0;
      let duplicateCount = 0;
      for (const item of parseFeedEntries(feedText)) {
        const canonicalUrl = item.url ? normalizeUrl(item.url) ?? source.websiteUrl : source.websiteUrl;
        const fingerprint = fingerprintArticle(item.title, item.excerpt, canonicalUrl);
        const existing = (await this.deps.articles.listBySource(sourceId)).find((article) => {
          if (item.externalId && article.externalId && article.externalId === item.externalId) return true;
          if (canonicalUrl && article.canonicalUrl && article.canonicalUrl === canonicalUrl) return true;
          return fingerprintArticle(article.originalTitle, article.originalExcerpt, article.canonicalUrl ?? article.originalUrl) === fingerprint;
        });

        if (existing) {
          duplicateCount += 1;
          continue;
        }

        const publishedAt = parseDate(item.publishedAt ?? undefined);
        const discoveredAt = new Date();
        await this.deps.articles.create({
          sourceId,
          originalUrl: canonicalUrl,
          originalTitle: item.title,
          externalId: item.externalId,
          canonicalUrl,
          // Only the language is derived; title/content/URL/dates are stored as received.
          originalLanguage: resolveArticleLanguage({ feedLanguage, title: item.title, excerpt: item.excerpt }),
          originalExcerpt: item.excerpt,
          originalContent: item.content ?? item.excerpt,
          publishedAt,
          publishedDateJst: publishedAt ? getJstDate(publishedAt) : null,
          discoveredAt: discoveredAt.toISOString(),
          processingStatus: "pending",
          // Late = discovered on a later JST day than published (not merely "published in the past").
          lateArrival: publishedAt ? isLateArrival(new Date(publishedAt), discoveredAt) : false,
          missedDigestCutoff: false,
        });
        newCount += 1;
      }

      await this.deps.sources.markCollectionSucceeded(sourceId, new Date().toISOString());
      return { new: newCount, duplicate: duplicateCount, failed: 0 };
    } catch (error) {
      const errorCode = error instanceof AppError ? error.code : "COLLECTION_FAILED";
      await this.deps.sources.markCollectionFailed(sourceId, errorCode, new Date().toISOString());
      throw error;
    }
  }
}

export function createRuntimeSourceService(options: {
  pool?: Pool;
  enqueueCollection?: (sourceId: string) => Promise<string | null>;
} = {}): SourceService {
  if (environment.databaseUrl) {
    const repositories = createPostgresRepositories(options.pool ?? new Pool({ connectionString: environment.databaseUrl }));
    return new SourceService({ sources: repositories.sources, articles: repositories.articles, enqueueCollection: options.enqueueCollection });
  }
  return createMemorySourceService(options.enqueueCollection);
}
