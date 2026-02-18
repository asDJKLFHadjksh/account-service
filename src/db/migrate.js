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

function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}

function ensureColumn(db, table, column, definition) {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
    ensureColumn(db, 'users', 'free_redeem_used', "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, 'users', 'redeem_credits', "INTEGER NOT NULL DEFAULT 0");
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
