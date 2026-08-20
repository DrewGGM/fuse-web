/**
 * The slice of D1 this Worker actually uses.
 *
 * Pulling in the full `@cloudflare/workers-types` would redefine Request,
 * Response and friends across a workspace that also compiles browser code, and
 * the resulting lib conflicts cost more than they buy. Four methods is the whole
 * surface here, and declaring them locally also lets the SQLite-backed test
 * adapter satisfy the same interface without pretending to be a Worker runtime.
 */

export interface D1Result {
  /** Rows the statement actually changed. D1 and the SQLite test adapter both
   *  populate this; it is how a conditional INSERT reports whether it fired. */
  readonly meta: { readonly changes?: number; readonly rows_written?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1Result>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}
