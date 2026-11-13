import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import {
  canTransitionDelivery,
  catchUpModeAt,
  cronTickPlan,
  digestDateFor,
  digestDisplayDate,
  digestIdempotencyKey,
  digestSubject,
  digestTimeline,
  EMPTY_DIGEST_MESSAGE,
  isLateArrival,
  jstDateOf,
  nextDigestSend,
} from "@aidnd/domain";

import { FakeEmailProvider } from "../email/fake-provider.js";
import { EmailProviderError } from "../email/provider.js";
import { mapResendEvent, ResendEmailProvider, verifyResendWebhook } from "../email/resend-provider.js";
import { silentProcessingLogger } from "../events/processor.js";
import type { JobQueue } from "../queue/job-queue.js";
import { DIGEST_CRON, startDigestScheduler, type DigestJobDeps } from "./jobs.js";
import { escapeHtml, renderDigestEmail, safeHttpUrl } from "./render.js";

const FAKE_RESEND_KEY = "re_unit_test_key_must_never_leak_42";

// ---------------------------------------------------------------------------
// JST date + schedule rules
// ---------------------------------------------------------------------------

test("JST calendar dates and Digest date are independent of the host timezone", () => {
  assert.equal(jstDateOf(new Date("2026-11-12T14:59:59Z")), "2026-11-12"); // 23:59:59 JST
  assert.equal(jstDateOf(new Date("2026-11-12T15:00:00Z")), "2026-11-13"); // 00:00 JST
  // Sent on 13/11 JST → carries news of 12/11.
  assert.equal(digestDateFor(new Date("2026-11-12T22:00:00Z")), "2026-11-12"); // 07:00 JST 13/11
  assert.equal(digestDateFor(new Date("2026-11-12T15:00:00Z")), "2026-11-12"); // 00:00 JST 13/11
  assert.equal(digestDateFor(new Date("2026-11-12T14:59:00Z")), "2026-11-11"); // 23:59 JST 12/11
  assert.equal(digestDateFor(new Date("2026-12-31T22:00:00Z")), "2026-12-31"); // year boundary
});

test("late arrival means discovered on a later JST day than published (Phase 7 regression)", () => {
  // Same JST day (published 11:01 JST, discovered 11:04 JST) is NOT late — the live bug marked it late.
  assert.equal(isLateArrival(new Date("2026-11-13T02:01:00Z"), new Date("2026-11-13T02:04:00Z")), false);
  // Published 23:50 JST on the 11th, discovered 08:00 JST on the 12th → late (product spec §28).
  assert.equal(isLateArrival(new Date("2026-11-11T14:50:00Z"), new Date("2026-11-11T23:00:00Z")), true);
  // Same UTC day but crossing JST midnight → late.
  assert.equal(isLateArrival(new Date("2026-11-11T14:59:00Z"), new Date("2026-11-11T15:00:00Z")), true);
});

test("schedule instants: 06:45 JST cutoff and 07:00 JST send on D+1", () => {
  const { cutoffAt, sendAt } = digestTimeline("2026-11-12");
  assert.equal(cutoffAt.toISOString(), "2026-11-12T21:45:00.000Z");
  assert.equal(sendAt.toISOString(), "2026-11-12T22:00:00.000Z");
  assert.deepEqual(
    { ...nextDigestSend(new Date("2026-11-12T21:59:00Z")), sendAt: nextDigestSend(new Date("2026-11-12T21:59:00Z")).sendAt.toISOString() },
    { localDate: "2026-11-12", sendAt: "2026-11-12T22:00:00.000Z" },
  );
  assert.equal(nextDigestSend(new Date("2026-11-12T22:00:00Z")).localDate, "2026-11-13");
  assert.equal(catchUpModeAt(new Date("2026-11-12T20:59:00Z")), null); // 05:59 JST
  assert.equal(catchUpModeAt(new Date("2026-11-12T21:00:00Z")), "draft"); // 06:00 JST
  assert.equal(catchUpModeAt(new Date("2026-11-12T21:45:00Z")), "finalize"); // 06:45 JST
  assert.equal(catchUpModeAt(new Date("2026-11-13T03:00:00Z")), "finalize"); // 12:00 JST
});

test("subject, display date, idempotency key, and delivery state machine", () => {
  assert.equal(digestSubject("2026-11-12"), "Tin nhanh ngày 12");
  assert.equal(digestSubject("2026-11-05"), "Tin nhanh ngày 05");
  assert.equal(digestDisplayDate("2026-11-12"), "12/11/2026");
  assert.equal(digestIdempotencyKey("u-1", "2026-11-12"), "daily-digest:u-1:2026-11-12");
  assert.ok(canTransitionDelivery("pending", "sending"));
  assert.ok(canTransitionDelivery("sending", "unknown"));
  assert.ok(canTransitionDelivery("unknown", "accepted"));
  assert.ok(canTransitionDelivery("accepted", "delivered"));
  assert.ok(!canTransitionDelivery("delivered", "sending"), "never resend a delivered email");
  assert.ok(!canTransitionDelivery("accepted", "sending"), "never resend an accepted email");
});

// ---------------------------------------------------------------------------
// Email rendering
// ---------------------------------------------------------------------------

const event = {
  eventId: "00000000-0000-4000-8000-000000000001",
  position: 1,
  titleVi: "Bão X đổ bộ miền Trung <script>alert(1)</script>",
  summaryVi: "Bão X đã đổ bộ vào miền Trung. Mưa lớn gây ngập úng.",
  sources: ["VTV", "VnExpress", "VTV", "NHK"],
  articles: [
    { articleId: "00000000-0000-4000-8000-0000000000a1", sourceName: "VnExpress", originalTitle: "Bão X \"đổ bộ\" & gây mưa", originalUrl: "https://vnexpress.net/bao-x?a=1&b=2", publishedAt: "2026-11-12T09:00:00.000Z" },
    { articleId: "00000000-0000-4000-8000-0000000000a2", sourceName: "Evil", originalTitle: "x", originalUrl: "javascript:alert(1)", publishedAt: null },
  ],
};

test("email HTML escapes untrusted text, keeps only http(s) links, and de-duplicates sources", () => {
  const email = renderDigestEmail({ localDate: "2026-11-12", events: [event] });
  assert.equal(email.subject, "Tin nhanh ngày 12");
  assert.match(email.html, /Tin nhanh ngày 12\/11\/2026/);
  assert.ok(email.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!email.html.includes("<script>"));
  assert.ok(!email.html.toLowerCase().includes("javascript:"));
  assert.ok(email.html.includes('href="https://vnexpress.net/bao-x?a=1&amp;b=2"'));
  assert.ok(email.html.includes("Nguồn:</strong> VTV · VnExpress · NHK"));
  assert.ok(email.html.includes("18:00 JST"), "publication time shown in JST");
  assert.ok(email.html.includes('lang="vi"') && email.html.includes('charset="utf-8"'));
  assert.match(email.text, /Đọc nguồn:\n- VnExpress: https:\/\/vnexpress\.net/);
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(safeHttpUrl("ftp://example.com"), null);
  assert.equal(safeHttpUrl("https://user:pass@example.com"), null);
});

test("empty Digest renders the standard Vietnamese empty message", () => {
  const email = renderDigestEmail({ localDate: "2026-11-12", events: [] });
  assert.ok(email.html.includes(EMPTY_DIGEST_MESSAGE));
  assert.ok(email.html.includes("0 sự kiện"));
  assert.ok(email.text.includes(EMPTY_DIGEST_MESSAGE));
});

// ---------------------------------------------------------------------------
// Resend adapter
// ---------------------------------------------------------------------------

type Call = { url: string; init: RequestInit };
const fakeFetch = (respond: () => Response, calls: Call[] = []) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;

const sendInput = {
  from: "news@example.test",
  to: "reader@example.com",
  subject: "Tin nhanh ngày 12",
  html: "<p>x</p>",
  text: "x",
  idempotencyKey: "daily-digest:u-1:2026-11-12",
};

test("Resend adapter sends with bearer auth + Idempotency-Key and never puts the key in the URL", async () => {
  const calls: Call[] = [];
  const provider = new ResendEmailProvider({
    apiKey: FAKE_RESEND_KEY,
    fetchImpl: fakeFetch(() => new Response(JSON.stringify({ id: "msg_123" }), { status: 200 }), calls),
  });
  assert.deepEqual(await provider.send(sendInput), { status: "accepted", providerMessageId: "msg_123" });
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(calls[0]!.url, "https://api.resend.com/emails");
  assert.equal(headers.authorization, `Bearer ${FAKE_RESEND_KEY}`);
  assert.equal(headers["Idempotency-Key"], sendInput.idempotencyKey);
  assert.ok(!calls[0]!.url.includes(FAKE_RESEND_KEY));
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.deepEqual(body.to, ["reader@example.com"]);
  assert.equal(body.from, "news@example.test");
});

test("Resend adapter maps failures to transient / ambiguous / permanent without leaking secrets", async () => {
  const cases: Array<{ respond: () => Response; code: string; kind: string }> = [
    { respond: () => new Response(JSON.stringify({ name: "invalid_api_key" }), { status: 403 }), code: "EMAIL_AUTH_ERROR", kind: "permanent" },
    { respond: () => new Response(JSON.stringify({ name: "validation_error" }), { status: 422 }), code: "EMAIL_INVALID_REQUEST", kind: "permanent" },
    { respond: () => new Response("{}", { status: 429, headers: { "retry-after": "3" } }), code: "EMAIL_RATE_LIMITED", kind: "transient" },
    { respond: () => new Response("{}", { status: 503 }), code: "EMAIL_PROVIDER_UNAVAILABLE", kind: "transient" },
    { respond: () => new Response(JSON.stringify({ name: "concurrent_idempotent_requests" }), { status: 409 }), code: "EMAIL_IDEMPOTENCY_CONFLICT", kind: "transient" },
    { respond: () => new Response(JSON.stringify({ name: "invalid_idempotent_request" }), { status: 409 }), code: "EMAIL_INVALID_REQUEST", kind: "permanent" },
    { respond: () => new Response("not json", { status: 200 }), code: "EMAIL_INVALID_RESPONSE", kind: "ambiguous" },
  ];
  for (const entry of cases) {
    const provider = new ResendEmailProvider({ apiKey: FAKE_RESEND_KEY, fetchImpl: fakeFetch(entry.respond) });
    await assert.rejects(provider.send(sendInput), (error: unknown) => {
      assert.ok(error instanceof EmailProviderError);
      assert.equal(error.code, entry.code);
      assert.equal(error.kind, entry.kind);
      assert.ok(!`${error.message} ${JSON.stringify(error)}`.includes(FAKE_RESEND_KEY));
      return true;
    });
  }

  const timeout = new ResendEmailProvider({
    apiKey: FAKE_RESEND_KEY,
    fetchImpl: (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as typeof fetch,
  });
  await assert.rejects(timeout.send(sendInput), (error: unknown) => error instanceof EmailProviderError && error.code === "EMAIL_TIMEOUT" && error.kind === "ambiguous");

  let called = false;
  const missing = new ResendEmailProvider({ apiKey: undefined, fetchImpl: (async () => ((called = true), new Response("{}"))) as typeof fetch });
  await assert.rejects(missing.send(sendInput), (error: unknown) => error instanceof EmailProviderError && error.code === "EMAIL_NOT_CONFIGURED");
  assert.equal(called, false);
});

test("Resend delivery status and event mapping", async () => {
  const delivered = new ResendEmailProvider({ apiKey: FAKE_RESEND_KEY, fetchImpl: fakeFetch(() => new Response(JSON.stringify({ last_event: "delivered" }))) });
  assert.equal(await delivered.getDeliveryStatus("msg_1"), "delivered");
  const missing = new ResendEmailProvider({ apiKey: FAKE_RESEND_KEY, fetchImpl: fakeFetch(() => new Response("{}", { status: 404 })) });
  assert.equal(await missing.getDeliveryStatus("msg_1"), "not_found");
  assert.equal(mapResendEvent("email.sent"), "accepted");
  assert.equal(mapResendEvent("email.delivered"), "delivered");
  assert.equal(mapResendEvent("email.bounced"), "failed");
  assert.equal(mapResendEvent("email.unknown_future_event"), null);
});

test("Resend webhook signatures are verified (Svix scheme) with replay protection", () => {
  const secret = `whsec_${Buffer.from("unit-test-webhook-secret").toString("base64")}`;
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "msg_1" } });
  const now = new Date("2026-11-13T00:00:00Z");
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const sign = (payload: string, ts = timestamp) =>
    `v1,${createHmac("sha256", Buffer.from("unit-test-webhook-secret")).update(`evt_1.${ts}.${payload}`).digest("base64")}`;

  assert.ok(verifyResendWebhook(secret, { id: "evt_1", timestamp, signature: sign(body) }, body, now));
  assert.ok(verifyResendWebhook(secret, { id: "evt_1", timestamp, signature: `v1,bogus ${sign(body)}` }, body, now), "rotated signatures");
  assert.ok(!verifyResendWebhook(secret, { id: "evt_1", timestamp, signature: sign(body) }, `${body} `, now), "tampered body");
  assert.ok(!verifyResendWebhook(`whsec_${Buffer.from("other").toString("base64")}`, { id: "evt_1", timestamp, signature: sign(body) }, body, now));
  const old = String(Math.floor(now.getTime() / 1000) - 3600);
  assert.ok(!verifyResendWebhook(secret, { id: "evt_1", timestamp: old, signature: sign(body, old) }, body, now), "stale timestamp");
  assert.ok(!verifyResendWebhook(secret, { id: undefined, timestamp, signature: sign(body) }, body, now));
});

test("FakeEmailProvider de-duplicates by idempotency key like Resend", async () => {
  const fake = new FakeEmailProvider();
  const first = await fake.send(sendInput);
  const second = await fake.send(sendInput);
  assert.equal(first.providerMessageId, second.providerMessageId);
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.attempts.length, 2);
});

// ---------------------------------------------------------------------------
// Scheduler registration
// ---------------------------------------------------------------------------

function fakeQueue() {
  const schedules = new Map<string, { cron: string; timezone: string }>();
  const enqueued: Array<{ name: string; data?: Record<string, unknown> }> = [];
  const queue: JobQueue = {
    isReady: true,
    start: async () => undefined,
    stop: async () => undefined,
    enqueue: async (name, data) => {
      enqueued.push({ name, data });
      return `job-${enqueued.length}`;
    },
    work: async () => undefined,
    schedule: async (name, cron, timezone) => {
      schedules.set(name, { cron, timezone });
    },
    unschedule: async (name) => {
      schedules.delete(name);
    },
  };
  return { queue, schedules, enqueued };
}

test("scheduler registers Asia/Tokyo crons idempotently and catches up after a restart", async () => {
  const { queue, schedules, enqueued } = fakeQueue();
  const deps = {
    queue,
    store: { listDigestUserIds: async () => ["user-1"] },
    generation: {},
    delivery: {},
    enqueueCollectAll: async () => 0,
    logger: silentProcessingLogger,
    now: () => new Date("2026-11-12T23:00:00Z"), // 08:00 JST on 13/11 (after the 06:45 cutoff)
  } as unknown as DigestJobDeps;

  await startDigestScheduler(deps);
  await startDigestScheduler(deps); // restart
  assert.equal(schedules.size, 3, "one schedule per tick, not duplicated on restart");
  assert.deepEqual(schedules.get(DIGEST_CRON.collect.queue), { cron: "30 5 * * *", timezone: "Asia/Tokyo" });
  assert.deepEqual(schedules.get(DIGEST_CRON.draft.queue), { cron: "0,30 6 * * *", timezone: "Asia/Tokyo" });
  assert.deepEqual(schedules.get(DIGEST_CRON.finalize.queue), { cron: "45 6 * * *", timezone: "Asia/Tokyo" });
  assert.deepEqual(enqueued.map((job) => job.data), [
    { userId: "user-1", localDate: "2026-11-12", mode: "finalize" },
    { userId: "user-1", localDate: "2026-11-12", mode: "finalize" },
  ]);

  const early = fakeQueue();
  await startDigestScheduler({ ...deps, queue: early.queue, now: () => new Date("2026-11-12T19:00:00Z") }); // 04:00 JST
  assert.equal(early.enqueued.length, 0, "no catch-up before 06:00 JST");
});

test("cron tick plan (Cron-job.org, JST clock only): wake / collect / draft / finalize", () => {
  const at = (hour: number, minute: number) => new Date(Date.UTC(2026, 10, 13, hour - 9, minute)); // 13 Nov JST
  const plan = (hour: number, minute: number) => {
    const { collect, mode, digestDate, today } = cronTickPlan(at(hour, minute));
    return [today, digestDate, collect, mode];
  };
  assert.deepEqual(plan(5, 0), ["2026-11-13", "2026-11-12", false, null], "before 05:30: wake only");
  assert.deepEqual(plan(5, 30), ["2026-11-13", "2026-11-12", true, null]);
  assert.deepEqual(plan(6, 0), ["2026-11-13", "2026-11-12", true, "draft"]);
  assert.deepEqual(plan(6, 44), ["2026-11-13", "2026-11-12", true, "draft"]);
  assert.deepEqual(plan(6, 45), ["2026-11-13", "2026-11-12", false, "finalize"], "06:45 cutoff: no more collection");
  assert.deepEqual(plan(7, 0), ["2026-11-13", "2026-11-12", false, "finalize"]);
  assert.deepEqual(plan(23, 59), ["2026-11-13", "2026-11-12", false, "finalize"]);
  // 00:10 JST on the 14th is still before 05:30: the 13th's Digest is not touched yet.
  assert.deepEqual(cronTickPlan(new Date(Date.UTC(2026, 10, 13, 15, 10))).mode, null);
});
