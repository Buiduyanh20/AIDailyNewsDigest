import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Session, User, UserSettings } from "@aidnd/domain";

import { environment } from "../config/env.js";
import { PostgresAuthStore } from "./repositories.js";
import { normalizeEmail } from "./auth-helpers.js";

export type AppUser = User;
export type AppSession = Session;
export type AppUserSettings = UserSettings;

export interface AuthStore {
  createUser(input: { email: string; passwordHash: string; disabledAt?: string | null }): Promise<AppUser>;
  createUserWithSettings(input: {
    email: string;
    passwordHash: string;
    recipientEmail: string;
    timezone: string;
    sendLocalTime: string;
  }): Promise<{ user: AppUser; settings: AppUserSettings }>;
  getUserById(id: string): Promise<AppUser | null>;
  getUserByEmail(email: string): Promise<AppUser | null>;
  createSession(input: { userId: string }): Promise<AppSession>;
  getSession(id: string): Promise<AppSession | null>;
  updateSessionLastSeen(id: string): Promise<void>;
  revokeSession(id: string): Promise<void>;
  revokeSessionsForUser(userId: string): Promise<void>;
  getUserSettings(userId: string): Promise<AppUserSettings | null>;
  createUserSettings(input: {
    userId: string;
    recipientEmail: string;
    timezone: string;
    sendLocalTime: string;
  }): Promise<AppUserSettings>;
}

export { normalizeEmail };

class MemoryAuthStore implements AuthStore {
  private readonly users = new Map<string, AppUser>();
  private readonly sessions = new Map<string, AppSession>();
  private readonly settings = new Map<string, AppUserSettings>();

  async createUser(input: { email: string; passwordHash: string; disabledAt?: string | null }): Promise<AppUser> {
    const email = normalizeEmail(input.email);
    if (Array.from(this.users.values()).some((user) => user.email === email)) {
      throw new Error("A user with that email already exists.");
    }

    const now = new Date().toISOString();
    const user: AppUser = {
      id: randomUUID(),
      email,
      passwordHash: input.passwordHash,
      disabledAt: input.disabledAt ?? null,
      createdAt: now,
      updatedAt: now,
    };

    this.users.set(user.id, user);
    return user;
  }

  async createUserWithSettings(input: {
    email: string;
    passwordHash: string;
    recipientEmail: string;
    timezone: string;
    sendLocalTime: string;
  }): Promise<{ user: AppUser; settings: AppUserSettings }> {
    const user = await this.createUser({ email: input.email, passwordHash: input.passwordHash });
    const settings = await this.createUserSettings({
      userId: user.id,
      recipientEmail: input.recipientEmail || user.email,
      timezone: input.timezone,
      sendLocalTime: input.sendLocalTime,
    });

    return { user, settings };
  }

  async getUserById(id: string): Promise<AppUser | null> {
    const user = this.users.get(id) ?? null;
    return user ? { ...user } : null;
  }

  async getUserByEmail(email: string): Promise<AppUser | null> {
    const normalized = normalizeEmail(email);
    const user = Array.from(this.users.values()).find((candidate) => candidate.email === normalized) ?? null;
    return user ? { ...user } : null;
  }

  async createSession(input: { userId: string }): Promise<AppSession> {
    const now = new Date();
    const session: AppSession = {
      id: randomUUID(),
      userId: input.userId,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      lastSeenAt: now.toISOString(),
      createdAt: now.toISOString(),
    };

    this.sessions.set(session.id, session);
    return { ...session };
  }

  async getSession(id: string): Promise<AppSession | null> {
    const session = this.sessions.get(id) ?? null;
    return session ? { ...session } : null;
  }

  async updateSessionLastSeen(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }

    session.lastSeenAt = new Date().toISOString();
  }

  async revokeSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async revokeSessionsForUser(userId: string): Promise<void> {
    for (const [sessionId, session] of this.sessions) {
      if (session.userId === userId) {
        this.sessions.delete(sessionId);
      }
    }
  }

  async getUserSettings(userId: string): Promise<AppUserSettings | null> {
    const settings = this.settings.get(userId) ?? null;
    return settings ? { ...settings } : null;
  }

  async createUserSettings(input: {
    userId: string;
    recipientEmail: string;
    timezone: string;
    sendLocalTime: string;
  }): Promise<AppUserSettings> {
    const existing = this.settings.get(input.userId);
    const now = new Date().toISOString();
    const settings: AppUserSettings = {
      userId: input.userId,
      recipientEmail: input.recipientEmail,
      timezone: input.timezone,
      sendLocalTime: input.sendLocalTime,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.settings.set(input.userId, settings);
    return { ...settings };
  }
}

let memoryAuthStore: MemoryAuthStore | null = null;

export function createAuthStore(pool?: Pool): AuthStore {
  if (pool) {
    return new PostgresAuthStore(pool);
  }

  if (!environment.databaseUrl) {
    if (environment.nodeEnv !== "test") {
      throw new Error("DATABASE_URL is required in development and production. Configure PostgreSQL before starting the server.");
    }

    if (!memoryAuthStore) {
      memoryAuthStore = new MemoryAuthStore();
    }
    return memoryAuthStore;
  }

  return new PostgresAuthStore(new Pool({ connectionString: environment.databaseUrl }));
}
