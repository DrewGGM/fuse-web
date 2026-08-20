/**
 * A D1-shaped adapter over Node's built-in SQLite.
 *
 * Testing the Worker against a hand-written fake would mean the fake decides
 * what `ON CONFLICT DO NOTHING`, `GROUP BY` and index behaviour mean — which is
 * exactly where the interesting bugs live. Node 24 ships `node:sqlite`, so the
 * tests can run against a real engine with no native install and no container.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Row = Record<string, unknown>;

class Statement {
  private args: unknown[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}

  bind(...args: unknown[]): Statement {
    this.args = args;
    return this;
  }

  run(): Promise<{ success: true; meta: { changes: number } }> {
    // node:sqlite reports the affected-row count as `changes`, which is exactly
    // what D1 exposes as meta.changes. Surfacing it lets the conditional INSERT
    // that enforces the attempt limit be tested against a real SQL engine.
    const info = this.db.prepare(this.sql).run(...(this.args as never[]));
    return Promise.resolve({ success: true, meta: { changes: Number(info.changes ?? 0) } });
  }

  first<T = Row>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.args as never[]));
    return Promise.resolve((row as T) ?? null);
  }

  all<T = Row>(): Promise<{ results: T[] }> {
    const rows = this.db.prepare(this.sql).all(...(this.args as never[]));
    return Promise.resolve({ results: rows as T[] });
  }
}

export interface TestDb {
  prepare(sql: string): Statement;
  close(): void;
}

export function createTestDb(): TestDb {
  const db = new DatabaseSync(':memory:');

  // Apply the real migrations, so a schema change that breaks a query is caught
  // here rather than in production.
  const dir = fileURLToPath(new URL('../migrations', import.meta.url));
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    db.exec(readFileSync(`${dir}/${file}`, 'utf8'));
  }

  return {
    prepare: (sql: string) => new Statement(db, sql),
    close: () => db.close(),
  };
}
