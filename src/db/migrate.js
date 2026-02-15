const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function main() {
  const dbPath = requireEnv('DB_PATH');
  ensureDir(path.dirname(dbPath));

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  db.exec(schema);
  db.close();

  console.log(`✅ Migration OK: ${dbPath}`);
}

main();
