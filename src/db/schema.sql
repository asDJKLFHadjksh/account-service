PRAGMA foreign_keys = ON;

-- =========================
-- USERS
-- =========================
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,

  totp_secret     TEXT,
  totp_enabled    INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0,1)),

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  free_redeem_used INTEGER NOT NULL DEFAULT 0,

  CHECK (username = lower(username)),
  CHECK (length(username) BETWEEN 3 AND 20)
);

CREATE TRIGGER IF NOT EXISTS trg_users_updated_at
AFTER UPDATE ON users
FOR EACH ROW
BEGIN
  UPDATE users SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- =========================
-- RECOVERY CODES (hashed only, one-time use)
-- =========================
CREATE TABLE IF NOT EXISTS recovery_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  code_hash   TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, code_hash)
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_used ON recovery_codes(user_id, used);

-- =========================
-- TEMPLATES (default profile owner)
-- =========================
CREATE TABLE IF NOT EXISTS templates (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              INTEGER NOT NULL,

  name                 TEXT NOT NULL DEFAULT 'Default',
  base_tag_name        TEXT NOT NULL DEFAULT 'Bandul',

  instructions_default TEXT NOT NULL DEFAULT
    'Silakan hubungi saya terlebih dahulu. Nanti kita bisa atur alamat atau bertemu di tempat yang disepakati bersama.',

  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS trg_templates_updated_at
AFTER UPDATE ON templates
FOR EACH ROW
BEGIN
  UPDATE templates SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_templates_user ON templates(user_id);

-- =========================
-- CONTACTS (allowlist provider) - TEMPLATE
-- =========================
CREATE TABLE IF NOT EXISTS contacts_template (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,

  provider    TEXT NOT NULL CHECK (
    provider IN ('whatsapp','instagram','telegram','email','messenger')
  ),

  handle      TEXT NOT NULL,

  created_at  TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ctemplate_template ON contacts_template(template_id);

-- =========================
-- TAGS / ID TAG (bandul)
-- =========================
CREATE TABLE IF NOT EXISTS tags (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL,
  template_id         INTEGER,

  label               TEXT NOT NULL,
  code12              TEXT NOT NULL UNIQUE,

  is_active           INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
  manually_disabled   INTEGER NOT NULL DEFAULT 0 CHECK (manually_disabled IN (0,1)),
  override_contact    INTEGER NOT NULL DEFAULT 0 CHECK (override_contact IN (0,1)),

  instructions_override TEXT,

  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL
);

CREATE TRIGGER IF NOT EXISTS trg_tags_updated_at
AFTER UPDATE ON tags
FOR EACH ROW
BEGIN
  UPDATE tags SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tags_user_label ON tags(user_id, label);
CREATE INDEX IF NOT EXISTS idx_tags_user ON tags(user_id);
CREATE INDEX IF NOT EXISTS idx_tags_active ON tags(user_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_code12_unique ON tags(code12);

CREATE TABLE IF NOT EXISTS redeem_archive (
  user_id INTEGER PRIMARY KEY,
  codes_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- =========================
-- CONTACTS (allowlist provider) - TAG OVERRIDE
-- =========================
CREATE TABLE IF NOT EXISTS contacts_tag (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id     INTEGER NOT NULL,

  provider   TEXT NOT NULL CHECK (
    provider IN ('whatsapp','instagram','telegram','email','messenger')
  ),

  handle     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ctag_tag ON contacts_tag(tag_id);
