const { isValidCode12, isValidDirectLink } = require('../utils/validators');

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
    this.addColumnIfMissing('tags', tagCols, 'created_at TEXT', 'created_at');
    this.addColumnIfMissing('tags', tagCols, 'updated_at TEXT', 'updated_at');

    this.db.exec(
      "UPDATE tags SET created_at = COALESCE(created_at, datetime('now')), updated_at = COALESCE(updated_at, datetime('now'))"
    );

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
        code12: pickFirst(refreshedTagCols, ['code12']),
        name: pickFirst(refreshedTagCols, ['name', 'label']),
        enabled: pickFirst(refreshedTagCols, ['enabled', 'is_enabled', 'is_active', 'active']),
        contactLinkOverride: pickFirst(refreshedTagCols, ['contact_link_override', 'direct_link_override']),
        createdAt: pickFirst(refreshedTagCols, ['created_at']),
        updatedAt: pickFirst(refreshedTagCols, ['updated_at']),
        notes: pickFirst(refreshedTagCols, ['notes']),
        description: pickFirst(refreshedTagCols, ['description']),
        meetLocationText: pickFirst(refreshedTagCols, ['meet_location_text']),
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
    return {
      ...row,
      enabled: Boolean(row[this.schema.tags.enabled]),
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

  generateUniqueCode12() {
    const codeCol = this.schema.tags.code12;
    const sql = `SELECT 1 FROM tags WHERE ${quoteIdent(codeCol)} = ? LIMIT 1`;
    const stmt = this.db.prepare(sql);

    for (let i = 0; i < 50; i += 1) {
      const candidate = String(Math.floor(Math.random() * 10 ** 12)).padStart(12, '0');
      const exists = stmt.get(candidate);
      if (!exists) return candidate;
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

    const code12 = payload.code12 ? String(payload.code12).trim() : this.generateUniqueCode12();
    if (!isValidCode12(code12)) {
      throw new Error('code12 harus 12 digit numeric.');
    }

    const defaultLink = this.getTemplateDefaultLink(userId);
    const enabled = isValidDirectLink(defaultLink) ? 1 : 0;

    const columns = [this.schema.tags.userId, this.schema.tags.code12, enabledCol];
    const values = [userId, code12, enabled];

    if (nameCol) {
      columns.push(nameCol);
      values.push(String(payload.name || '').trim() || 'Bandul');
    }

    if (this.schema.tags.createdAt) {
      columns.push(this.schema.tags.createdAt);
      values.push(new Date().toISOString());
    }

    if (this.schema.tags.updatedAt) {
      columns.push(this.schema.tags.updatedAt);
      values.push(new Date().toISOString());
    }

    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT INTO tags (${columns.map(quoteIdent).join(', ')}) VALUES (${placeholders})`;

    try {
      const result = this.db.prepare(sql).run(...values);
      return this.getById(userId, Number(result.lastInsertRowid));
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        throw new Error('code12 sudah digunakan.');
      }
      throw error;
    }
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
