import { randomBytes } from "node:crypto";

import { hash, verify } from "argon2";
import type { FastifyReply, FastifyRequest } from "fastify";

import { environment } from "../config/env.js";
import { type AppSession, type AppUser, type AppUserSettings, type AuthStore, normalizeEmail } from "../db/auth-store.js";

export const SESSION_COOKIE_NAME = environment.sessionCookieName;
export const CSRF_COOKIE_NAME = "aidnd_csrf";
export const SESSION_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

export type AuthenticatedRequest = FastifyRequest & { user?: AppUser };

export function normalizePassword(password: string): string {
  return password.trim();
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

export function isCsrfTokenValid(token: string | undefined, expected: string | undefined): boolean {
  return Boolean(token) && token === expected;
}

export function buildSessionCookieOptions(useSecure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: useSecure,
    expires: new Date(Date.now() + SESSION_ABSOLUTE_TIMEOUT_MS),
  };
}

export function buildCsrfCookieOptions(useSecure: boolean) {
  return {
    httpOnly: false,
    sameSite: "lax" as const,
    path: "/",
    secure: useSecure,
  };
}

const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export class AuthService {
  private readonly failedLoginAttempts = new Map<string, { count: number; firstAttemptAt: number }>();

  constructor(private readonly store: AuthStore) {}

  isLoginRateLimited(email: string): boolean {
    const key = normalizeEmail(email);
    const attempt = this.failedLoginAttempts.get(key);
    if (!attempt) {
      return false;
    }

    const now = Date.now();
    if (now - attempt.firstAttemptAt > LOGIN_RATE_LIMIT_WINDOW_MS) {
      this.failedLoginAttempts.delete(key);
      return false;
    }

    return attempt.count >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS;
  }

  recordFailedLogin(email: string): void {
    const key = normalizeEmail(email);
    const now = Date.now();
    const attempt = this.failedLoginAttempts.get(key);
    if (!attempt) {
      this.failedLoginAttempts.set(key, { count: 1, firstAttemptAt: now });
      return;
    }

    const reachedWindow = now - attempt.firstAttemptAt > LOGIN_RATE_LIMIT_WINDOW_MS;
    if (reachedWindow) {
      this.failedLoginAttempts.set(key, { count: 1, firstAttemptAt: now });
      return;
    }

    this.failedLoginAttempts.set(key, { count: attempt.count + 1, firstAttemptAt: attempt.firstAttemptAt });
  }

  clearFailedLogin(email: string): void {
    this.failedLoginAttempts.delete(normalizeEmail(email));
  }

  async authenticate(email: string, password: string): Promise<AppUser | null> {
    const normalizedEmail = normalizeEmail(email);
    const user = await this.store.getUserByEmail(normalizedEmail);
    if (!user) {
      return null;
    }

    if (user.disabledAt) {
      return null;
    }

    const passwordMatches = await verifyPassword(user.passwordHash, password);
    if (!passwordMatches) {
      return null;
    }

    return user;
  }

  async createUser(email: string, password: string): Promise<AppUser> {
    return this.store.createUser({
      email: normalizeEmail(email),
      passwordHash: await hashPassword(password),
    });
  }

  async provisionAdmin(email: string, password: string): Promise<{ user: AppUser; settings: AppUserSettings }> {
    const normalizedEmail = normalizeEmail(email);
    const user = await this.store.createUserWithSettings({
      email: normalizedEmail,
      passwordHash: await hashPassword(password),
      recipientEmail: normalizedEmail,
      timezone: "Asia/Tokyo",
      sendLocalTime: "07:00",
    });

    return user;
  }

  async createSession(userId: string): Promise<AppSession> {
    return this.store.createSession({ userId });
  }

  async getSessionUser(sessionId: string): Promise<AppUser | null> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      return null;
    }

    const now = Date.now();
    const expiresAt = Date.parse(session.expiresAt);
    const lastSeenAt = Date.parse(session.lastSeenAt);

    if (Number.isNaN(expiresAt) || expiresAt <= now) {
      await this.store.revokeSession(sessionId);
      return null;
    }

    if (Number.isNaN(lastSeenAt) || now - lastSeenAt > SESSION_IDLE_TIMEOUT_MS) {
      await this.store.revokeSession(sessionId);
      return null;
    }

    const user = await this.store.getUserById(session.userId);
    if (!user || user.disabledAt) {
      await this.store.revokeSession(sessionId);
      return null;
    }

    await this.store.updateSessionLastSeen(sessionId);
    return user;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.store.revokeSession(sessionId);
  }

  async logout(sessionId: string): Promise<boolean> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      return false;
    }

    await this.store.revokeSession(sessionId);
    return true;
  }
}

export function requireAuth(authService: AuthService) {
  return async function (request: AuthenticatedRequest, reply: FastifyReply): Promise<void> {
    const sessionId = request.cookies?.[SESSION_COOKIE_NAME];
    if (!sessionId) {
      reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }

    const user = await authService.getSessionUser(sessionId);
    if (!user) {
      reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }

    request.user = user;
  };
}
