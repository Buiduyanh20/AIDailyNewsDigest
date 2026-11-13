import { migrateDatabase } from "./migrate.js";

try {
  await migrateDatabase();
  console.log("Database migrations complete.");
} catch (error) {
  console.error("Database migration failed.");
  console.error(error);
  process.exitCode = 1;
}
