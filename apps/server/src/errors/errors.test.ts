import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ConflictError,
  ForbiddenError,
  InfrastructureError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  toApiError,
} from "./index.js";

test("reusable errors map to the shared API error shape", () => {
  const cases = [
    [new ValidationError("Invalid input."), 400, "VALIDATION_ERROR"],
    [new NotFoundError(), 404, "NOT_FOUND"],
    [new ConflictError(), 409, "CONFLICT"],
    [new UnauthorizedError(), 401, "UNAUTHORIZED"],
    [new ForbiddenError(), 403, "FORBIDDEN"],
    [new InfrastructureError(), 500, "INFRASTRUCTURE_ERROR"],
  ] as const;

  for (const [error, statusCode, code] of cases) {
    assert.deepEqual(toApiError(error), {
      statusCode,
      body: { error: { code, message: error.message } },
    });
  }
});

test("unexpected errors never expose their message or stack", () => {
  const mapped = toApiError(new Error("sensitive SQL details"));

  assert.equal(mapped.statusCode, 500);
  assert.deepEqual(mapped.body, {
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." },
  });
  assert.equal(JSON.stringify(mapped).includes("sensitive SQL details"), false);
});
