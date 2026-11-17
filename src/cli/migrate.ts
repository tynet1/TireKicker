// Apply pending migrations and seed data without starting the web server.
//   npm run migrate
import { pool } from "../db.ts";
import { migrate } from "../migrate.ts";
import { ensureAdmin, seedVehicles } from "../seed.ts";

try {
  const applied = await migrate();
  if (!applied.length) console.log("database is up to date");
  await ensureAdmin(console.log);
  await seedVehicles(console.log);
} finally {
  await pool.end();
}
