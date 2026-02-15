require('dotenv').config();
const { run, db } = require('../src/db');

async function init() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      totp_secret_encrypted TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      code_hash TEXT NOT NULL,
      is_used INTEGER NOT NULL DEFAULT 0,
      used_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_recovery_code_hash ON recovery_codes(code_hash)');

  console.log('Database initialized.');
  db.close();
}

init().catch((error) => {
  console.error('Failed to initialize database:', error.message);
  db.close();
  process.exit(1);
});
