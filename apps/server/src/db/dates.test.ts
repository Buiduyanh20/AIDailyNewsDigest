import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET ??= `test-session-${randomBytes(16).toString("hex")}`;
delete process.env.DATABASE_URL;

const { dateOnly } = await import("./repositories.js");
const { getJstDate } = await import("../sources/service.js");

test("JST calendar date boundaries (Asia/Tokyo, independent of host timezone)", () => {
  assert.equal(getJstDate("2026-11-11T14:59:00Z"), "2026-11-11", "23:59 JST stays on the 11th");
  assert.equal(getJstDate("2026-11-11T15:00:00Z"), "2026-11-12", "00:00 JST is the 12th");
  assert.equal(getJstDate("2026-11-11T15:30:00Z"), "2026-11-12", "00:30 JST is the 12th");
  assert.equal(getJstDate(null), null);
  assert.equal(getJstDate("not a date"), null);
});

test("dateOnly preserves PostgreSQL DATE values exactly", () => {
  // node-postgres parses DATE '2026-11-12' as local midnight on the host.
  assert.equal(dateOnly(new Date(2026, 10, 12)), "2026-11-12");
  assert.equal(dateOnly(new Date(2026, 0, 1)), "2026-01-01");
  assert.equal(dateOnly(new Date(2026, 11, 31)), "2026-12-31");
  assert.equal(dateOnly("2026-11-12"), "2026-11-12");
});
