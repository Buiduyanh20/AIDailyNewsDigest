import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { environment } from "../config/env.js";
import { AuthService } from "../auth/service.js";
import { createAuthStore } from "../db/auth-store.js";
import { migrateDatabase } from "../db/migrate.js";

async function promptForAdminDetails(): Promise<{ email: string; password: string }> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const email = process.env.ADMIN_EMAIL?.trim() || environment.adminEmail || (await rl.question("Admin email: ")).trim();
    const configuredPassword = process.env.ADMIN_PASSWORD?.trim() || environment.adminPassword;
    const password = configuredPassword || (await rl.question("Admin password: "));
    return { email, password };
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  await migrateDatabase();
  const authService = new AuthService(createAuthStore());
  const { email, password } = await promptForAdminDetails();

  try {
    const result = await authService.provisionAdmin(email, password);
    console.log(`Created admin account for ${result.user.email}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(message);
    process.exitCode = 1;
  }
}

await main();
