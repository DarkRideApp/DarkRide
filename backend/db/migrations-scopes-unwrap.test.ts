import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

/**
 * Verifies the 0079_scopes_unwrap_double_encoded migration
 * unwraps double-encoded JSON scopes in users + api_keys.
 */
describe('migration: scopes unwrap double-encoded', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_hash TEXT NOT NULL,
        scopes TEXT NOT NULL
      );
    `);
  });

  function applyMigration() {
    const migrationsDir = path.resolve(__dirname, '../../migrations');
    const file = fs.readdirSync(migrationsDir)
      .find(f => /_scopes_unwrap_double_encoded\.sql$/.test(f));
    if (!file) throw new Error('migration file not found');
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.exec(sql);
  }

  function getScopes(table: 'users' | 'api_keys', id: number): string {
    const row = db.prepare(`SELECT scopes FROM ${table} WHERE id = ?`).get(id) as { scopes: string };
    return row.scopes;
  }

  it('unwraps double-encoded scopes in users', () => {
    // JSON.stringify(JSON.stringify(['core.admin:*'])) — what the buggy
    // writers actually produced once Drizzle's mode:'json' stringified again.
    const doubleEncoded = JSON.stringify(JSON.stringify(['core.admin:*']));
    db.prepare('INSERT INTO users (username, scopes) VALUES (?, ?)').run('alice', doubleEncoded);
    applyMigration();
    expect(getScopes('users', 1)).toBe('["core.admin:*"]');
  });

  it('unwraps double-encoded scopes in api_keys', () => {
    const doubleEncoded = JSON.stringify(JSON.stringify(['core.apk:read', 'mcp']));
    db.prepare('INSERT INTO api_keys (key_hash, scopes) VALUES (?, ?)').run('h', doubleEncoded);
    applyMigration();
    const v = getScopes('api_keys', 1);
    expect(JSON.parse(v)).toEqual(['core.apk:read', 'mcp']);
  });

  it('leaves single-encoded scopes untouched semantically', () => {
    const clean = JSON.stringify(['core.apk:read']);
    db.prepare('INSERT INTO users (username, scopes) VALUES (?, ?)').run('bob', clean);
    applyMigration();
    expect(JSON.parse(getScopes('users', 1))).toEqual(['core.apk:read']);
  });

  it('is idempotent', () => {
    const doubleEncoded = JSON.stringify(JSON.stringify(['core.admin:*']));
    db.prepare('INSERT INTO users (username, scopes) VALUES (?, ?)').run('carol', doubleEncoded);
    applyMigration();
    applyMigration();
    expect(JSON.parse(getScopes('users', 1))).toEqual(['core.admin:*']);
  });

  it('handles empty scopes "[]" (single-encoded default) as a no-op', () => {
    db.prepare('INSERT INTO users (username, scopes) VALUES (?, ?)').run('dave', '[]');
    applyMigration();
    expect(getScopes('users', 1)).toBe('[]');
  });

  it('handles double-encoded empty scopes', () => {
    const doubleEncodedEmpty = JSON.stringify('[]'); // '"[]"'
    db.prepare('INSERT INTO users (username, scopes) VALUES (?, ?)').run('eve', doubleEncodedEmpty);
    applyMigration();
    expect(getScopes('users', 1)).toBe('[]');
  });
});
