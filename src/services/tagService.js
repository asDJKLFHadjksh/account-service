const { isValidCode12, isValidDirectLink } = require('../utils/validators');

const CODE12_CHARSET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function pickFirst(columns, candidates) {
  return candidates.find((name) => columns.has(name)) || null;
}

class TagService {
  constructor(db) {
    this.db = db;
    this.schema = this.initializeSchema();
  }

  tableExists(name) {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
    return Boolean(row);
  }

  getColumns(tableName) {
    return this.db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all();
  }

  addColumnIfMissing(tableName, columnsSet, columnSql, columnName) {
    if (columnsSet.has(columnName)) return;
    this.db.exec(`ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${columnSql}`);
    columnsSet.add(columnName);
  }

  initializeSchema() {
    if (!this.tableExists('tags')) {
      throw new Error('Table tags tidak ditemukan. Jalankan migration terlebih dahulu.');
    }

    let tagTemplateTable = null;
    if (this.tableExists('tag_templates')) {
      tagTemplateTable = 'tag_templates';
    } else if (this.tableExists('templates')) {
      tagTemplateTable = 'templates';
    }

    const tagCols = new Set(this.getColumns('tags').map((c) => c.name));

    this.addColumnIfMissing('tags', tagCols, 'enabled INTEGER NOT NULL DEFAULT 0', 'enabled');
    this.addColumnIfMissing('tags', tagCols, 'contact_link_override TEXT', 'contact_link_override');
    this.addColumnIfMissing('tags', tagCols, 'code12 TEXT', 'code12');
    this.addColumnIfMissing('tags', tagCols, 'created_at TEXT', 'created_at');
    this.addColumnIfMissing('tags', tagCols, 'updated_at TEXT', 'updated_at');

    this.db.exec(
      "UPDATE tags SET created_at = COALESCE(created_at, datetime('now')), updated_at = COALESCE(updated_at, datetime('now'))"
    );
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_code12_unique ON tags(code12)');

    if (this.tableExists('users')) {
      const userCols = new Set(this.getColumns('users').map((c) => c.name));
      this.addColumnIfMissing('users', userCols, 'free_redeem_used INTEGER NOT NULL DEFAULT 0', 'free_redeem_used');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS redeem_archive (
        user_id INTEGER PRIMARY KEY,
        codes_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    let templateCols = new Set();
    if (tagTemplateTable) {
      templateCols = new Set(this.getColumns(tagTemplateTable).map((c) => c.name));
      this.addColumnIfMissing(
        tagTemplateTable,
        templateCols,
        'default_contact_link TEXT',
        'default_contact_link'
      );
    }

    const refreshedTagCols = new Set(this.getColumns('tags').map((c) => c.name));
    const refreshedTemplateCols =
      tagTemplateTable ? new Set(this.getColumns(tagTemplateTable).map((c) => c.name)) : new Set();

    return {
      tagTemplateTable,
      tags: {
        id: pickFirst(refreshedTagCols, ['id']),
        userId: pickFirst(refreshedTagCols, ['user_id']),
        code12: pickFirst(refreshedTagCols, ['code12', 'unique_code']),
        name: pickFirst(refreshedTagCols, ['name', 'label', 'tag_name']),
        enabled: pickFirst(refreshedTagCols, ['enabled', 'is_enabled', 'is_active', 'active']),
        contactLinkOverride: pickFirst(refreshedTagCols, ['contact_link_override', 'direct_link_override', 'direct_link']),
        createdAt: pickFirst(refreshedTagCols, ['created_at']),
        updatedAt: pickFirst(refreshedTagCols, ['updated_at']),
        notes: pickFirst(refreshedTagCols, ['notes']),
        description: pickFirst(refreshedTagCols, ['description']),
        meetLocationText: pickFirst(refreshedTagCols, ['meet_location_text', 'location_note']),
      },
      templates: {
        userId: pickFirst(refreshedTemplateCols, ['user_id']),
        defaultContactLink: pickFirst(refreshedTemplateCols, [
          'default_contact_link',
          'contact_link_default',
          'direct_link_message',
          'default_direct_link',
        ]),
      },
    };
  }

  ensureRequiredColumns() {
    if (!this.schema.tags.id || !this.schema.tags.userId || !this.schema.tags.code12) {
      throw new Error('Schema tags belum memenuhi requirement minimal (id, user_id, code12).');
    }
  }

  mapTagRow(row) {
    if (!row) return null;

    const rawName = String(row.name ?? row.tag_name ?? row.label ?? '').trim();
    const rawCode12 = String(row.code12 ?? row.unique_code ?? '').trim();
    const rawLocation = String(row.meet_location_text ?? row.location_note ?? row.notes ?? '');
    const rawLink = String(row.contact_link_override ?? row.direct_link ?? row.direct_link_override ?? '');
    const rawEnabled = row.enabled ?? row.is_active ?? row.is_enabled ?? row.active;

    return {
      ...row,
      name: rawName || 'Bandul',
      code12: rawCode12,
      meet_location_text: rawLocation,
      contact_link_override: rawLink,
      enabled: Boolean(rawEnabled),
    };
  }

  getTemplateDefaultLink(userId) {
    const { tagTemplateTable, templates } = this.schema;
    if (!tagTemplateTable || !templates.userId || !templates.defaultContactLink) {
      return '';
    }

    const orderCol = pickFirst(new Set(this.getColumns(tagTemplateTable).map((c) => c.name)), [
      'updated_at',
      'created_at',
      'id',
    ]);

    const sql = `
      SELECT ${quoteIdent(templates.defaultContactLink)} AS default_contact_link
      FROM ${quoteIdent(tagTemplateTable)}
      WHERE ${quoteIdent(templates.userId)} = ?
      ${orderCol ? `ORDER BY ${quoteIdent(orderCol)} DESC` : ''}
      LIMIT 1
    `;
    const row = this.db.prepare(sql).get(userId);
    return (row?.default_contact_link || '').trim();
  }

  resolveEffectiveDirectLink(tagRow, userId) {
    const overrideCol = this.schema.tags.contactLinkOverride;
    const overrideValue = overrideCol ? String(tagRow[overrideCol] || '').trim() : '';
    if (overrideValue) return overrideValue;
    return this.getTemplateDefaultLink(userId);
  }

  randomCode12() {
    let out = '';
    for (let i = 0; i < 12; i += 1) {
      out += CODE12_CHARSET[Math.floor(Math.random() * CODE12_CHARSET.length)];
    }
    return out;
  }

  isCode12Reserved(candidate) {
    const codeCol = this.schema.tags.code12;
    const inTags = this.db
      .prepare(`SELECT 1 FROM tags WHERE ${quoteIdent(codeCol)} = ? LIMIT 1`)
      .get(candidate);
    if (inTags) return true;

    const rows = this.db.prepare('SELECT codes_json FROM redeem_archive').all();
    for (const row of rows) {
      try {
        const codes = JSON.parse(row.codes_json || '[]');
        if (Array.isArray(codes) && codes.includes(candidate)) {
          return true;
        }
      } catch (error) {
        // ignore malformed archive data
      }
    }

    return false;
  }

  generateUniqueCode12(excludeSet = new Set()) {
    for (let i = 0; i < 100; i += 1) {
      const candidate = this.randomCode12();
      if (excludeSet.has(candidate)) continue;
      if (!this.isCode12Reserved(candidate)) return candidate;
    }

    throw new Error('Gagal generate code12 unik. Coba lagi.');
  }

  listByUser(userId) {
    this.ensureRequiredColumns();
    const orderCol = this.schema.tags.createdAt || this.schema.tags.id;
    const rows = this.db
      .prepare(
        `SELECT * FROM tags WHERE ${quoteIdent(this.schema.tags.userId)} = ? ORDER BY ${quoteIdent(orderCol)} DESC`
      )
      .all(userId);
    return rows.map((row) => this.mapTagRow(row));
  }

  create(userId, payload) {
    this.ensureRequiredColumns();
    const nameCol = this.schema.tags.name;
    const enabledCol = this.schema.tags.enabled;

    const requestedCode12 = payload.code12 ? String(payload.code12).trim().toUpperCase() : null;
    if (requestedCode12 && !isValidCode12(requestedCode12)) {
      throw new Error('code12 harus 12 digit angka.');
    }

    const defaultLink = this.getTemplateDefaultLink(userId);
    const enabled = isValidDirectLink(defaultLink) ? 1 : 0;

    const columns = [this.schema.tags.userId, this.schema.tags.code12, enabledCol];

    if (nameCol) {
      columns.push(nameCol);
    }

    if (this.schema.tags.createdAt) {
      columns.push(this.schema.tags.createdAt);
    }

    if (this.schema.tags.updatedAt) {
      columns.push(this.schema.tags.updatedAt);
    }

    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT INTO tags (${columns.map(quoteIdent).join(', ')}) VALUES (${placeholders})`;

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code12 = requestedCode12 || this.generateUniqueCode12();
      const values = [userId, code12, enabled];

      if (nameCol) {
        values.push(String(payload.name || '').trim() || 'Bandul');
      }

      if (this.schema.tags.createdAt) {
        values.push(new Date().toISOString());
      }

      if (this.schema.tags.updatedAt) {
        values.push(new Date().toISOString());
      }

      try {
        const result = this.db.prepare(sql).run(...values);
        return this.getById(userId, Number(result.lastInsertRowid));
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) {
          if (requestedCode12) {
            throw new Error('code12 sudah digunakan.');
          }
          continue;
        }
        throw error;
      }
    }

    throw new Error('Gagal generate code12 unik. Coba lagi.');
  }

  getById(userId, id) {
    this.ensureRequiredColumns();
    const row = this.db
      .prepare(
        `SELECT * FROM tags WHERE ${quoteIdent(this.schema.tags.id)} = ? AND ${quoteIdent(this.schema.tags.userId)} = ?`
      )
      .get(id, userId);
    return this.mapTagRow(row);
  }

  patch(userId, id, payload) {
    if (Object.prototype.hasOwnProperty.call(payload, 'user_id') || Object.prototype.hasOwnProperty.call(payload, 'code12')) {
      throw new Error('Field user_id dan code12 tidak bisa diubah.');
    }

    const editable = [
      ['name', this.schema.tags.name],
      ['notes', this.schema.tags.notes],
      ['description', this.schema.tags.description],
      ['meet_location_text', this.schema.tags.meetLocationText],
      ['contact_link_override', this.schema.tags.contactLinkOverride],
    ];

    const setParts = [];
    const values = [];

    for (const [inputKey, column] of editable) {
      if (!column) continue;
      if (Object.prototype.hasOwnProperty.call(payload, inputKey)) {
        setParts.push(`${quoteIdent(column)} = ?`);
        values.push(payload[inputKey]);
      }
    }

    if (!setParts.length) {
      return this.getById(userId, id);
    }

    if (this.schema.tags.updatedAt) {
      setParts.push(`${quoteIdent(this.schema.tags.updatedAt)} = ?`);
      values.push(new Date().toISOString());
    }

    values.push(id, userId);
    const sql = `
      UPDATE tags
      SET ${setParts.join(', ')}
      WHERE ${quoteIdent(this.schema.tags.id)} = ?
        AND ${quoteIdent(this.schema.tags.userId)} = ?
    `;

    const result = this.db.prepare(sql).run(...values);
    if (!result.changes) return null;

    return this.getById(userId, id);
  }

  toggle(userId, id, enabled) {
    const row = this.getById(userId, id);
    if (!row) return null;

    if (enabled) {
      const effectiveLink = this.resolveEffectiveDirectLink(row, userId);
      if (!isValidDirectLink(effectiveLink)) {
        const error = new Error('Direct link belum diisi. Isi dulu untuk mengaktifkan.');
        error.statusCode = 400;
        throw error;
      }
    }

    const setParts = [`${quoteIdent(this.schema.tags.enabled)} = ?`];
    const values = [enabled ? 1 : 0];

    if (this.schema.tags.updatedAt) {
      setParts.push(`${quoteIdent(this.schema.tags.updatedAt)} = ?`);
      values.push(new Date().toISOString());
    }

    values.push(id, userId);

    const sql = `
      UPDATE tags
      SET ${setParts.join(', ')}
      WHERE ${quoteIdent(this.schema.tags.id)} = ?
        AND ${quoteIdent(this.schema.tags.userId)} = ?
    `;
    this.db.prepare(sql).run(...values);

    return { enabled: Boolean(enabled) };
  }
}

module.exports = TagService;
