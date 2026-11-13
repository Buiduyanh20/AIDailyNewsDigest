import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = `test-session-${randomBytes(16).toString("hex")}`;
process.env.CORS_ORIGIN = "http://localhost:5173";
process.env.ADMIN_EMAIL = `admin-${randomBytes(8).toString("hex")}@example.com`;
process.env.ADMIN_PASSWORD = `AdminPassword-${randomBytes(10).toString("hex")}!`;

delete process.env.DATABASE_URL;

const { buildApp } = await import("./app.js");
const { AuthService, hashPassword, verifyPassword } = await import("./auth/service.js");
const { createAuthStore } = await import("./db/auth-store.js");
const { createMemorySourceService } = await import("./sources/service.js");
const { parseEnvironment } = await import("./config/env.js");

const app = buildApp({
  sourceService: createMemorySourceService(async (sourceId) => `test-job:${sourceId}`),
});

after(async () => {
  await app.close();
});

function makePassword(): string {
  return `TestPassword-${randomBytes(10).toString("hex")}!`;
}

function makeSecret(): string {
  return `test-secret-${randomBytes(16).toString("hex")}`;
}

function createCsrfHeaders() {
  return { "x-csrf-token": "test-token", cookie: "aidnd_csrf=test-token" };
}

test("GET /health returns the server health status", async () => {
  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
});

test("GET /ready reports not-ready dependencies", async () => {
  const readinessApp = buildApp({ readinessCheck: async () => false });
  try {
    const response = await readinessApp.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { status: "not_ready" });
  } finally {
    await readinessApp.close();
  }
});

test("unexpected HTTP errors use the centralized API error format", async () => {
  const response = await app.inject({ method: "GET", url: "/missing-route" });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: { code: "NOT_FOUND", message: "The requested resource was not found." },
  });
});

test("password hashing and verification work correctly", async () => {
  const password = makePassword();
  const hash = await hashPassword(password);

  assert.notEqual(hash, password);
  assert.match(hash, /^\$argon2id\$/);
  assert.equal(await verifyPassword(hash, password), true);
  assert.equal(await verifyPassword(hash, "wrong-password"), false);
});

test("admin provisioning creates user and settings and rejects duplicates", async () => {
  const authService = new AuthService(createAuthStore());
  const email = `admin-${Date.now()}@example.com`;
  const password = makePassword();

  const result = await authService.provisionAdmin(email, password);
  assert.equal(result.user.email, email);
  assert.equal(result.settings.userId, result.user.id);
  assert.equal(result.settings.timezone, "Asia/Tokyo");
  assert.equal(result.settings.sendLocalTime, "07:00");
  assert.notEqual(JSON.stringify(result), password);

  await assert.rejects(() => authService.provisionAdmin(email, password), /already exists|duplicate/i);
});

test("login accepts valid credentials and rejects invalid credentials with a generic error", async () => {
  const email = `login-${Date.now()}@example.com`;
  const password = makePassword();
  const wrongPassword = makePassword();
  const authService = new AuthService(createAuthStore());
  await authService.provisionAdmin(email, password);

  const csrfResult = await app.inject({ method: "GET", url: "/api/v1/auth/csrf" });
  const csrfToken = csrfResult.json().token;

  const validResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
    headers: { "x-csrf-token": csrfToken, cookie: `aidnd_csrf=${csrfToken}` },
  });

  assert.equal(validResponse.statusCode, 200);
  assert.equal(validResponse.json().user.email, email);
  assert.ok(validResponse.cookies.some((cookie: { name: string }) => cookie.name === "aidnd_session"));

  const invalidResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: wrongPassword },
    headers: { "x-csrf-token": csrfToken, cookie: `aidnd_csrf=${csrfToken}` },
  });

  assert.equal(invalidResponse.statusCode, 401);
  assert.equal(invalidResponse.json().error, "Invalid email or password.");

  const unknownResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: `missing-${Date.now()}@example.com`, password: wrongPassword },
    headers: { "x-csrf-token": csrfToken, cookie: `aidnd_csrf=${csrfToken}` },
  });

  assert.equal(unknownResponse.statusCode, 401);
  assert.equal(unknownResponse.json().error, "Invalid email or password.");
});

test("disabled account cannot log in and invalid input is rejected", async () => {
  const email = `disabled-${Date.now()}@example.com`;
  const store = createAuthStore();
  const disabledPassword = makePassword();
  const passwordHash = await hashPassword(disabledPassword);
  await store.createUser({ email, passwordHash, disabledAt: new Date().toISOString() });

  const csrfResult = await app.inject({ method: "GET", url: "/api/v1/auth/csrf" });
  const csrfToken = csrfResult.json().token;

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: disabledPassword },
    headers: { "x-csrf-token": csrfToken, cookie: `aidnd_csrf=${csrfToken}` },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, "Invalid email or password.");

  const invalidRequest = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "bad-email", password: "short" },
    headers: createCsrfHeaders(),
  });

  assert.equal(invalidRequest.statusCode, 400);
  assert.equal(invalidRequest.json().error, "Invalid email or password.");
});

test("session endpoints and cookie flow work for authenticated and unauthenticated sessions", async () => {
  const email = `session-${Date.now()}@example.com`;
  const password = makePassword();
  const authService = new AuthService(createAuthStore());
  await authService.provisionAdmin(email, password);

  const csrfResult = await app.inject({ method: "GET", url: "/api/v1/auth/csrf" });
  const csrfToken = csrfResult.json().token;
  const loginResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
    headers: { "x-csrf-token": csrfToken, cookie: `aidnd_csrf=${csrfToken}` },
  });

  const sessionCookie = loginResponse.cookies.find((cookie: { name: string }) => cookie.name === "aidnd_session");
  if (!sessionCookie) {
    throw new Error("expected session cookie to exist after login");
  }

  const validSession = await app.inject({
    method: "GET",
    url: "/api/v1/auth/session",
    headers: { cookie: `aidnd_session=${sessionCookie.value}` },
  });

  assert.equal(validSession.statusCode, 200);
  assert.equal(validSession.json().user.email, email);

  const missingSession = await app.inject({ method: "GET", url: "/api/v1/auth/session" });
  assert.equal(missingSession.statusCode, 401);

  const store = createAuthStore();
  const expiredUser = await store.getUserByEmail(email);
  const expiredSession = await store.createSession({ userId: expiredUser!.id });
  await store.revokeSession(expiredSession.id);
  const revokedSession = await app.inject({
    method: "GET",
    url: "/api/v1/auth/session",
    headers: { cookie: `aidnd_session=${expiredSession.id}` },
  });
  assert.equal(revokedSession.statusCode, 401);

  const expiredUserInfo = await store.getUserByEmail(email);
  const expiredCookieSession = await store.createSession({ userId: expiredUserInfo!.id });
  const expiredAtDate = new Date(Date.now() - 1000).toISOString();
  const sessionMap = new Map(Object.entries((store as any).sessions ?? {}));
  sessionMap.set(expiredCookieSession.id, { ...expiredCookieSession, expiresAt: expiredAtDate });
  (store as any).sessions = sessionMap;

  const expiredSessionResponse = await app.inject({
    method: "GET",
    url: "/api/v1/auth/session",
    headers: { cookie: `aidnd_session=${expiredCookieSession.id}` },
  });

  assert.equal(expiredSessionResponse.statusCode, 401);
});

test("logout invalidates the server session", async () => {
  const email = `logout-${Date.now()}@example.com`;
  const password = makePassword();
  const authService = new AuthService(createAuthStore());
  await authService.provisionAdmin(email, password);

  const csrfResult = await app.inject({ method: "GET", url: "/api/v1/auth/csrf" });
  const csrfToken = csrfResult.json().token;
  const loginResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
    headers: { "x-csrf-token": csrfToken, cookie: `aidnd_csrf=${csrfToken}` },
  });

  const sessionCookie = loginResponse.cookies.find((cookie: { name: string }) => cookie.name === "aidnd_session");
  if (!sessionCookie) {
    throw new Error("expected session cookie to exist after login");
  }

  const sessionBefore = await app.inject({
    method: "GET",
    url: "/api/v1/auth/session",
    headers: { cookie: `aidnd_session=${sessionCookie.value}` },
  });
  assert.equal(sessionBefore.statusCode, 200);

  const logoutResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: { "x-csrf-token": csrfToken, cookie: `aidnd_session=${sessionCookie.value}; aidnd_csrf=${csrfToken}` },
  });

  assert.equal(logoutResponse.statusCode, 200);
  const sessionAfter = await app.inject({
    method: "GET",
    url: "/api/v1/auth/session",
    headers: { cookie: `aidnd_session=${sessionCookie.value}` },
  });
  assert.equal(sessionAfter.statusCode, 401);
});

test("protected routes reject and allow valid sessions", async () => {
  const email = `protected-${Date.now()}@example.com`;
  const password = makePassword();
  const authService = new AuthService(createAuthStore());
  await authService.provisionAdmin(email, password);

  const csrfResult = await app.inject({ method: "GET", url: "/api/v1/auth/csrf" });
  const csrfToken = csrfResult.json().token;
  const loginResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
    headers: { "x-csrf-token": csrfToken, cookie: `aidnd_csrf=${csrfToken}` },
  });

  const sessionCookie = loginResponse.cookies.find((cookie: { name: string }) => cookie.name === "aidnd_session");
  if (!sessionCookie) {
    throw new Error("expected session cookie to exist after login");
  }

  const missingSession = await app.inject({ method: "GET", url: "/api/v1/protected" });
  assert.equal(missingSession.statusCode, 401);

  const allowedSession = await app.inject({
    method: "GET",
    url: "/api/v1/protected",
    headers: { cookie: `aidnd_session=${sessionCookie.value}` },
  });
  assert.equal(allowedSession.statusCode, 200);
  assert.equal(allowedSession.json().user.email, email);

  const store = createAuthStore();
  const expiredSession = await store.createSession({ userId: (await store.getUserByEmail(email))!.id });
  const pastSessionValue = expiredSession.id;
  const sessionMap = new Map(Object.entries((store as any).sessions ?? {}));
  sessionMap.set(expiredSession.id, { ...expiredSession, expiresAt: new Date(Date.now() - 1000).toISOString() });
  (store as any).sessions = sessionMap;

  const expiredProtected = await app.inject({
    method: "GET",
    url: "/api/v1/protected",
    headers: { cookie: `aidnd_session=${pastSessionValue}` },
  });

  assert.equal(expiredProtected.statusCode, 401);
});

test("CSRF protection rejects missing/invalid tokens and accepts valid tokens", async () => {
  const email = `csrf-${Date.now()}@example.com`;
  const password = makePassword();
  await new AuthService(createAuthStore()).provisionAdmin(email, password);

  const csfrResponse = await app.inject({ method: "GET", url: "/api/v1/auth/csrf" });
  const csrfToken = csfrResponse.json().token;

  const missingToken = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
    headers: { cookie: `aidnd_csrf=${csrfToken}` },
  });
  assert.equal(missingToken.statusCode, 403);

  const invalidToken = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
    headers: { "x-csrf-token": "bad-token", cookie: `aidnd_csrf=${csrfToken}` },
  });
  assert.equal(invalidToken.statusCode, 403);

  const validResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
    headers: { "x-csrf-token": csrfToken, cookie: `aidnd_csrf=${csrfToken}` },
  });
  assert.equal(validResponse.statusCode, 200);
});

test("failed logins trigger rate limiting and block successful login while rate limited", async () => {
  const email = `rate-${Date.now()}@example.com`;
  const password = makePassword();
  const wrongPassword = makePassword();
  const limiterKey = `rate-limit-${Date.now()}`;
  const authService = new AuthService(createAuthStore());
  await authService.provisionAdmin(email, password);

  const csrfResult = await app.inject({ method: "GET", url: "/api/v1/auth/csrf" });
  const csrfToken = csrfResult.json().token;

  let lastStatus = 200;
  for (let index = 0; index < 7; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: wrongPassword },
      headers: {
        "x-csrf-token": csrfToken,
        cookie: `aidnd_csrf=${csrfToken}`,
        "x-forwarded-for": limiterKey,
      },
    });
    lastStatus = response.statusCode;
  }

  assert.equal(lastStatus, 429);

  const blocked = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
    headers: {
      "x-csrf-token": csrfToken,
      cookie: `aidnd_csrf=${csrfToken}`,
      "x-forwarded-for": limiterKey,
    },
  });

  assert.equal(blocked.statusCode, 429);
});

test("source management respects user ownership and supports create, list, update, delete, and retry", async () => {
  const userA = `source-user-a-${Date.now()}@example.com`;
  const userB = `source-user-b-${Date.now()}@example.com`;
  const password = makePassword();
  const authService = new AuthService(createAuthStore());
  const userARecord = await authService.provisionAdmin(userA, password);
  const userBRecord = await authService.provisionAdmin(userB, password);

  const csrfA = (await app.inject({ method: "GET", url: "/api/v1/auth/csrf" })).json().token;
  const loginA = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: userA, password },
    headers: { "x-csrf-token": csrfA, cookie: `aidnd_csrf=${csrfA}` },
  });
  const sessionA = loginA.cookies.find((cookie: { name: string }) => cookie.name === "aidnd_session");
  assert.ok(sessionA);

  const create = await app.inject({
    method: "POST",
    url: "/api/v1/sources",
    payload: { name: "VnExpress", websiteUrl: "https://vnexpress.net", rssUrl: "https://example.com/rss.xml", enabled: true },
    headers: { "x-csrf-token": csrfA, cookie: `aidnd_csrf=${csrfA}; aidnd_session=${sessionA!.value}` },
  });
  assert.equal(create.statusCode, 200);
  const created = create.json();
  assert.equal(created.name, "VnExpress");

  const list = await app.inject({
    method: "GET",
    url: "/api/v1/sources?page=1&pageSize=20",
    headers: { cookie: `aidnd_session=${sessionA!.value}` },
  });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().items.some((source: { id: string }) => source.id === created.id));

  const update = await app.inject({
    method: "PATCH",
    url: `/api/v1/sources/${created.id}`,
    payload: { name: "VnExpress Updated", enabled: false },
    headers: { "x-csrf-token": csrfA, cookie: `aidnd_csrf=${csrfA}; aidnd_session=${sessionA!.value}` },
  });
  assert.equal(update.statusCode, 200);
  assert.equal(update.json().name, "VnExpress Updated");

  const csrfB = (await app.inject({ method: "GET", url: "/api/v1/auth/csrf" })).json().token;
  const loginB = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: userB, password },
    headers: { "x-csrf-token": csrfB, cookie: `aidnd_csrf=${csrfB}` },
  });
  const sessionB = loginB.cookies.find((cookie: { name: string }) => cookie.name === "aidnd_session");
  assert.ok(sessionB);

  const denied = await app.inject({
    method: "GET",
    url: `/api/v1/sources/${created.id}`,
    headers: { cookie: `aidnd_session=${sessionB!.value}` },
  });
  assert.equal(denied.statusCode, 404);

  const disabledRetry = await app.inject({
    method: "POST",
    url: `/api/v1/sources/${created.id}/retry`,
    headers: { "x-csrf-token": csrfA, cookie: `aidnd_csrf=${csrfA}; aidnd_session=${sessionA!.value}` },
  });
  assert.equal(disabledRetry.statusCode, 400);

  const enable = await app.inject({
    method: "PATCH",
    url: `/api/v1/sources/${created.id}`,
    payload: { enabled: true },
    headers: { "x-csrf-token": csrfA, cookie: `aidnd_csrf=${csrfA}; aidnd_session=${sessionA!.value}` },
  });
  assert.equal(enable.statusCode, 200);

  const retry = await app.inject({
    method: "POST",
    url: `/api/v1/sources/${created.id}/retry`,
    headers: { "x-csrf-token": csrfA, cookie: `aidnd_csrf=${csrfA}; aidnd_session=${sessionA!.value}` },
  });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().status, "queued");
  assert.equal(retry.json().jobId, `test-job:${created.id}`);

  const deleteResponse = await app.inject({
    method: "DELETE",
    url: `/api/v1/sources/${created.id}`,
    headers: { "x-csrf-token": csrfA, cookie: `aidnd_csrf=${csrfA}; aidnd_session=${sessionA!.value}` },
  });
  assert.equal(deleteResponse.statusCode, 200);
  assert.equal(deleteResponse.json().deleted, true);

  const deletedList = await app.inject({
    method: "GET",
    url: "/api/v1/sources?status=disabled&search=vnexpress&page=1&pageSize=1",
    headers: { cookie: `aidnd_session=${sessionA!.value}` },
  });
  assert.equal(deletedList.statusCode, 200);
  assert.deepEqual(deletedList.json().items, []);
  assert.equal(deletedList.json().total, 0);

  const afterDelete = await app.inject({
    method: "GET",
    url: `/api/v1/sources/${created.id}`,
    headers: { cookie: `aidnd_session=${sessionA!.value}` },
  });
  assert.equal(afterDelete.statusCode, 404);

  assert.ok(userARecord.user.email);
  assert.ok(userBRecord.user.email);
});

test("every Source/Article mutation route requires a valid CSRF token", async () => {
  const email = `csrf-mutations-${Date.now()}@example.com`;
  const password = makePassword();
  await new AuthService(createAuthStore()).provisionAdmin(email, password);
  const loginCsrf = (await app.inject({ method: "GET", url: "/api/v1/auth/csrf" })).json().token as string;
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
    headers: { "x-csrf-token": loginCsrf, cookie: `aidnd_csrf=${loginCsrf}` },
  });
  const session = login.cookies.find((cookie: { name: string }) => cookie.name === "aidnd_session")!.value;
  const token = (await app.inject({ method: "GET", url: "/api/v1/auth/csrf" })).json().token as string;
  const send = (
    method: "POST" | "PATCH" | "DELETE",
    url: string,
    csrf: "missing" | "invalid" | "valid",
    payload?: Record<string, unknown>,
  ) =>
    app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      headers:
        csrf === "missing"
          ? { cookie: `aidnd_session=${session}; aidnd_csrf=${token}` }
          : { cookie: `aidnd_session=${session}; aidnd_csrf=${token}`, "x-csrf-token": csrf === "valid" ? token : "forged-token" },
    });

  const sourcePayload = { name: "CSRF Source", websiteUrl: "https://csrf.example.com", rssUrl: "https://example.com/rss.xml" };
  for (const csrf of ["missing", "invalid"] as const) {
    assert.equal((await send("POST", "/api/v1/sources", csrf, sourcePayload)).statusCode, 403, `POST /sources (${csrf})`);
  }
  const created = await send("POST", "/api/v1/sources", "valid", sourcePayload);
  assert.equal(created.statusCode, 200);
  const sourceId = created.json().id as string;

  const routes: Array<{ method: "POST" | "PATCH" | "DELETE"; url: string; payload?: Record<string, unknown>; ok: number }> = [
    { method: "PATCH", url: `/api/v1/sources/${sourceId}`, payload: { name: "CSRF Source Updated" }, ok: 200 },
    { method: "POST", url: `/api/v1/sources/${sourceId}/retry`, ok: 200 },
    { method: "DELETE", url: `/api/v1/sources/${sourceId}`, ok: 200 },
    // Memory mode has no Articles: a valid token passes CSRF and reaches the 404 lookup.
    { method: "POST", url: "/api/v1/articles/00000000-0000-4000-8000-000000000000/retry", ok: 404 },
  ];
  for (const route of routes) {
    for (const csrf of ["missing", "invalid"] as const) {
      const rejected = await send(route.method, route.url, csrf, route.payload);
      assert.equal(rejected.statusCode, 403, `${route.method} ${route.url} (${csrf})`);
    }
    const accepted = await send(route.method, route.url, "valid", route.payload);
    assert.equal(accepted.statusCode, route.ok, `${route.method} ${route.url} (valid)`);
  }
});

test("environment configuration rejects missing database URL outside tests and allows test memory mode", () => {
  const testSecret = makeSecret();

  assert.doesNotThrow(() =>
    parseEnvironment({
      NODE_ENV: "test",
      PORT: "3000",
      SESSION_SECRET: testSecret,
      CORS_ORIGIN: "http://localhost:5173",
    }),
  );

  assert.throws(() =>
    parseEnvironment({
      NODE_ENV: "development",
      PORT: "3000",
      SESSION_SECRET: makeSecret(),
      CORS_ORIGIN: "http://localhost:5173",
    }),
  );

  assert.throws(() =>
    parseEnvironment({
      NODE_ENV: "production",
      PORT: "3000",
      SESSION_SECRET: makeSecret(),
      CORS_ORIGIN: "http://localhost:5173",
    }),
  );
});

// ---------------------------------------------------------------------------
// Phase 9 — production configuration, Cron trigger, single-container web serving
// ---------------------------------------------------------------------------

const { isAuthorizedCronRequest } = await import("./app.js");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

test("production configuration requires PORT, an exact https CORS origin, and a strong cron token", () => {
  const base = {
    NODE_ENV: "production",
    PORT: "10000",
    DATABASE_URL: "postgres://user:pass@db.example.invalid/neondb?sslmode=require",
    SESSION_SECRET: makeSecret(),
    CORS_ORIGIN: "https://digest.buiduyanh.io.vn",
  };
  const parsed = parseEnvironment(base);
  assert.equal(parsed.port, 10000);
  assert.equal(parsed.corsOrigin, "https://digest.buiduyanh.io.vn");
  assert.equal(parsed.digest.cronTriggerToken, undefined, "cron endpoint disabled until a token is configured");
  assert.equal(parsed.databasePoolMax, 10);

  assert.throws(() => parseEnvironment({ ...base, PORT: "" }), /PORT is required in production/);
  assert.throws(() => parseEnvironment({ ...base, CORS_ORIGIN: "" }), /CORS_ORIGIN/);
  assert.throws(() => parseEnvironment({ ...base, CORS_ORIGIN: "*" }), /CORS_ORIGIN/);
  assert.throws(() => parseEnvironment({ ...base, CORS_ORIGIN: "http://digest.buiduyanh.io.vn" }), /CORS_ORIGIN/);
  assert.throws(() => parseEnvironment({ ...base, CRON_TRIGGER_TOKEN: "short" }), /CRON_TRIGGER_TOKEN/);
  assert.throws(() => parseEnvironment({ ...base, DATABASE_POOL_MAX: "0" }), /DATABASE_POOL_MAX/);
  const token = "a".repeat(64);
  assert.equal(parseEnvironment({ ...base, CRON_TRIGGER_TOKEN: token }).digest.cronTriggerToken, token);

  // Development keeps its local defaults.
  const dev = parseEnvironment({ NODE_ENV: "development", DATABASE_URL: "postgres://localhost/aidnd", SESSION_SECRET: makeSecret() });
  assert.deepEqual([dev.port, dev.corsOrigin], [3000, "http://localhost:5173"]);
});

test("cron bearer check is exact and constant-time", () => {
  const token = "t".repeat(48);
  assert.equal(isAuthorizedCronRequest(`Bearer ${token}`, token), true);
  assert.equal(isAuthorizedCronRequest(undefined, token), false);
  assert.equal(isAuthorizedCronRequest(token, token), false, "scheme required");
  assert.equal(isAuthorizedCronRequest(`Basic ${token}`, token), false);
  assert.equal(isAuthorizedCronRequest(`Bearer ${token}x`, token), false);
  assert.equal(isAuthorizedCronRequest(`Bearer ${token.slice(1)}`, token), false);
  assert.equal(isAuthorizedCronRequest("Bearer ", token), false);
});

test("POST /api/v1/internal/cron/daily-digest: 404 when disabled, 401 without/with a wrong token, 202 when authorized", async () => {
  const token = randomBytes(32).toString("hex");
  let triggered = 0;
  const cronApp = buildApp({
    sourceService: createMemorySourceService(),
    cronTrigger: {
      token,
      trigger: async () => {
        triggered += 1;
        return { localDate: "2026-11-12", operations: [{ operation: "digest-finalize", jobId: triggered === 1 ? "job-1" : null }] };
      },
    },
  });
  const disabledApp = buildApp({ sourceService: createMemorySourceService(), cronTrigger: { token: undefined, trigger: async () => assert.fail("must not run") } });
  const url = "/api/v1/internal/cron/daily-digest";
  try {
    assert.equal((await disabledApp.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` } })).statusCode, 404);

    const missing = await cronApp.inject({ method: "POST", url });
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.headers["www-authenticate"], "Bearer");
    assert.equal(missing.json().error.code, "UNAUTHORIZED");

    const wrong = await cronApp.inject({ method: "POST", url, headers: { authorization: `Bearer ${randomBytes(32).toString("hex")}` } });
    assert.equal(wrong.statusCode, 401);
    const inQuery = await cronApp.inject({ method: "POST", url: `${url}?token=${token}` });
    assert.equal(inQuery.statusCode, 401, "a token in the URL is not accepted");
    const viaGet = await cronApp.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
    assert.equal(viaGet.statusCode, 404);
    assert.equal(triggered, 0);

    // Cron-job.org may send an empty JSON body or none at all.
    const ok = await cronApp.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    assert.equal(ok.statusCode, 202);
    assert.deepEqual(ok.json(), { status: "accepted", localDate: "2026-11-12", jobs: [{ operation: "digest-finalize", jobId: "job-1" }] });
    assert.ok(!ok.body.includes(token), "token never echoed");

    const again = await cronApp.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: "ignored" });
    assert.equal(again.statusCode, 202);
    assert.equal(again.json().jobs[0].jobId, null, "duplicate trigger reports a coalesced job");
    assert.equal(triggered, 2);
  } finally {
    await cronApp.close();
    await disabledApp.close();
  }
});

test("single container: built web app and SPA routes are served; API 404s stay JSON", async () => {
  const dist = mkdtempSync(join(tmpdir(), "aidnd-web-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><div id=\"root\"></div>");
  writeFileSync(join(dist, "assets", "index-abc123.js"), "console.log('app')");
  const webApp = buildApp({ sourceService: createMemorySourceService(), webDistDir: dist });
  try {
    const root = await webApp.inject({ method: "GET", url: "/" });
    assert.equal(root.statusCode, 200);
    assert.match(root.body, /id="root"/);
    assert.equal(root.headers["cache-control"], "no-cache");

    const deepLink = await webApp.inject({ method: "GET", url: "/digests/123" });
    assert.equal(deepLink.statusCode, 200);
    assert.match(String(deepLink.headers["content-type"]), /text\/html/);

    const asset = await webApp.inject({ method: "GET", url: "/assets/index-abc123.js" });
    assert.equal(asset.statusCode, 200);
    assert.match(String(asset.headers["cache-control"]), /immutable/);

    const apiMissing = await webApp.inject({ method: "GET", url: "/api/v1/does-not-exist" });
    assert.equal(apiMissing.statusCode, 404);
    assert.equal(apiMissing.json().error.code, "NOT_FOUND");
    assert.equal((await webApp.inject({ method: "GET", url: "/health" })).statusCode, 200);
    assert.equal((await webApp.inject({ method: "GET", url: "/../../package.json" })).statusCode !== 500, true);
  } finally {
    await webApp.close();
    rmSync(dist, { recursive: true, force: true });
  }
});
