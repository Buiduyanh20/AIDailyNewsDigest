import type { FastifyReply, FastifyRequest } from "fastify";

import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME, isCsrfTokenValid } from "./service.js";

export function validateCsrf(request: FastifyRequest, reply: FastifyReply): boolean {
  const headerToken = request.headers["x-csrf-token"];
  const cookieToken = request.cookies?.[CSRF_COOKIE_NAME];

  if (!headerToken || typeof headerToken !== "string") {
    reply.code(403).send({ error: "Invalid CSRF token." });
    return false;
  }

  if (!isCsrfTokenValid(headerToken, cookieToken)) {
    reply.code(403).send({ error: "Invalid CSRF token." });
    return false;
  }

  return true;
}

export function clearAuthCookies(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  reply.clearCookie(CSRF_COOKIE_NAME, { path: "/" });
}
