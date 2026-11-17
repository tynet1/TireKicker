// Add or reset a user from the command line (handy before the admin screen is set up).
//   npm run user -- add --name "Jane Doe" --role crew --pin 1234
//   npm run user -- add --name "Sam Lee" --role supervisor --email sam@example.com --password "long password"
//   npm run user -- pin --name "Jane Doe" --pin 5678
//   npm run user -- list
// In Docker: docker compose exec app node src/cli/user.ts add --name "Jane Doe" --role crew --pin 1234
import { parseArgs } from "node:util";
import { checkPassword, hashSecret, PIN_RE } from "../auth.ts";
import { one, pool, q } from "../db.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    role: { type: "string", default: "crew" },
    pin: { type: "string" },
    email: { type: "string" },
    password: { type: "string" },
  },
});

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

try {
  const cmd = positionals[0];
  if (cmd === "list") {
    const rows = await q(`SELECT id, name, role, email, active, pin_hash IS NOT NULL AS pin FROM users ORDER BY lower(name)`);
    console.table(rows);
  } else if (cmd === "add") {
    if (!values.name) fail("--name is required");
    if (!["crew", "shop", "supervisor", "admin"].includes(values.role!)) fail("--role must be crew, shop, supervisor or admin");
    if (values.pin && !PIN_RE.test(values.pin)) fail("--pin must be 4 to 6 digits");
    if (values.password) {
      const err = checkPassword(values.password);
      if (err) fail(err);
      if (!values.email) fail("--email is required with --password");
    }
    if (!values.pin && !values.password) fail("give --pin or --email/--password");
    const u = await one(
      `INSERT INTO users (name, role, email, pin_hash, password_hash) VALUES ($1, $2, lower($3), $4, $5) RETURNING id`,
      [values.name, values.role, values.email ?? null, values.pin ? await hashSecret(values.pin) : null,
        values.password ? await hashSecret(values.password) : null],
    );
    console.log(`added user ${values.name} (id ${u!.id})`);
  } else if (cmd === "pin") {
    if (!values.name || !values.pin || !PIN_RE.test(values.pin)) fail("usage: pin --name <name> --pin <4-6 digits>");
    const r = await q(`UPDATE users SET pin_hash = $2, failed_logins = 0, locked_until = NULL WHERE name = $1 RETURNING id`,
      [values.name, await hashSecret(values.pin)]);
    if (r.length !== 1) fail(`expected exactly one user named "${values.name}", found ${r.length}`);
    console.log(`PIN reset for ${values.name}`);
  } else {
    fail("usage: user.ts list | add --name ... | pin --name ... --pin ...");
  }
} finally {
  await pool.end();
}
