const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function runMigration() {
  const dbPath = requireEnv('DB_PATH');
  ensureDir(path.dirname(dbPath));

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    console.log(`✅ Migration OK: ${dbPath}`);
  } finally {
    db.close();
  }
}

try {
  runMigration();
} catch (error) {
  console.error('❌ Migration failed:', error);
  process.exitCode = 1;
}
