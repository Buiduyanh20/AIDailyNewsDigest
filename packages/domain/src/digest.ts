/**
 * Phase 6 domain rules for the Daily Digest. Pure and timezone-safe: every
 * calendar computation is done in Asia/Tokyo explicitly, never in the host's
 * local timezone.
 */

export const BUSINESS_TIMEZONE = "Asia/Tokyo";
/** JST is a fixed UTC+9 offset (no daylight saving). */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Product-controlled schedule (JST wall-clock times, read-only in the MVP). */
export const DIGEST_SCHEDULE = {
  collectionCutoff: "05:30",
  generate: "06:00",
  candidateSnapshot: "06:30",
  snapshotCutoff: "06:45",
  send: "07:00",
} as const;

export type DigestBuildMode = "draft" | "finalize";

/** Digest statuses in which the snapshot may still be rebuilt. */
export const MUTABLE_DIGEST_STATUSES = ["scheduled", "building"] as const;

export function isDigestFrozen(status: string): boolean {
  return !(MUTABLE_DIGEST_STATUSES as readonly string[]).includes(status);
}

/** JST calendar date ("YYYY-MM-DD") of an instant. */
export function jstDateOf(instant: Date): string {
  return new Date(instant.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Late arrival (product spec §28): the Article was discovered on a later JST
 * calendar day than the one it was published on. Same-day discovery is not late.
 */
export function isLateArrival(publishedAt: Date, discoveredAt: Date): boolean {
  return jstDateOf(discoveredAt) > jstDateOf(publishedAt);
}

/** Adds whole calendar days to a "YYYY-MM-DD" date (pure date arithmetic). */
export function addDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The Digest date sent on the JST day of `now` is the previous JST calendar day. */
export function digestDateFor(now: Date): string {
  return addDays(jstDateOf(now), -1);
}

/** UTC instant of a JST wall-clock time ("HH:MM") on a JST calendar date. */
export function jstInstant(localDate: string, time: string): Date {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - JST_OFFSET_MS);
}

/** Snapshot cutoff (06:45 JST) and send time (07:00 JST) for Digest date D, both on D+1. */
export function digestTimeline(localDate: string): { cutoffAt: Date; sendAt: Date } {
  const sendDay = addDays(localDate, 1);
  return {
    cutoffAt: jstInstant(sendDay, DIGEST_SCHEDULE.snapshotCutoff),
    sendAt: jstInstant(sendDay, DIGEST_SCHEDULE.send),
  };
}

/** Next 07:00 JST send moment strictly after `now`, with the Digest date it carries. */
export function nextDigestSend(now: Date): { localDate: string; sendAt: Date } {
  const today = jstDateOf(now);
  const todaySend = jstInstant(today, DIGEST_SCHEDULE.send);
  const sendDay = now.getTime() < todaySend.getTime() ? today : addDays(today, 1);
  return { localDate: addDays(sendDay, -1), sendAt: jstInstant(sendDay, DIGEST_SCHEDULE.send) };
}

/** What the scheduler should do for yesterday's Digest if it (re)starts at `now`. */
export function catchUpModeAt(now: Date): DigestBuildMode | null {
  const today = jstDateOf(now);
  const time = now.getTime();
  if (time >= jstInstant(today, DIGEST_SCHEDULE.snapshotCutoff).getTime()) return "finalize";
  if (time >= jstInstant(today, DIGEST_SCHEDULE.generate).getTime()) return "draft";
  return null;
}

/**
 * Phase 9: what an external Cron tick (Cron-job.org) should enqueue at `now`.
 * The app may have been asleep (Render free tier), so each tick re-derives the
 * due work from the JST clock alone; every operation is idempotent.
 *
 * - 05:30 ≤ t < 06:45 JST: final RSS collection for today (at most once per JST day).
 * - t ≥ 06:00 JST: generation for yesterday's Digest — "draft" before the 06:45
 *   cutoff, "finalize" after it. Finalize after 07:00 also re-enqueues delivery of
 *   a frozen, unsent Digest, so a tick at/after 07:00 performs the send.
 * - before 05:30 JST: nothing (the request only wakes the service).
 */
export function cronTickPlan(now: Date): { today: string; digestDate: string; collect: boolean; mode: DigestBuildMode | null } {
  const today = jstDateOf(now);
  const time = now.getTime();
  const collect =
    time >= jstInstant(today, DIGEST_SCHEDULE.collectionCutoff).getTime() &&
    time < jstInstant(today, DIGEST_SCHEDULE.snapshotCutoff).getTime();
  return { today, digestDate: digestDateFor(now), collect, mode: catchUpModeAt(now) };
}

/** "Tin nhanh ngày {DD}" — DD is the two-digit day of the Digest date. */
export function digestSubject(localDate: string): string {
  return `Tin nhanh ngày ${localDate.slice(8, 10)}`;
}

/** "DD/MM/YYYY" for display inside the email. */
export function digestDisplayDate(localDate: string): string {
  const [year, month, day] = localDate.split("-");
  return `${day}/${month}/${year}`;
}

export const EMPTY_DIGEST_MESSAGE = "Hôm nay không có tin nổi bật được tổng hợp.";

/** Stable logical identity of the one email per user per Digest date. */
export function digestIdempotencyKey(userId: string, localDate: string): string {
  return `daily-digest:${userId}:${localDate}`;
}

// ---------------------------------------------------------------------------
// Email delivery state machine
// ---------------------------------------------------------------------------

export type DeliveryState = "pending" | "sending" | "accepted" | "delivered" | "failed" | "unknown";

const DELIVERY_TRANSITIONS: Record<DeliveryState, readonly DeliveryState[]> = {
  pending: ["sending"],
  sending: ["accepted", "failed", "unknown"],
  // A retry (or reconciliation) re-enters "sending" from a non-final failure.
  failed: ["sending"],
  unknown: ["sending", "accepted", "delivered", "failed"],
  accepted: ["delivered", "failed"],
  delivered: [],
};

export function canTransitionDelivery(from: DeliveryState, to: DeliveryState): boolean {
  return from === to || DELIVERY_TRANSITIONS[from].includes(to);
}

/** Accepted means the provider took the request: the Digest counts as sent and is never resent. */
export function isDeliveryAccepted(state: DeliveryState): boolean {
  return state === "accepted" || state === "delivered";
}
