function testNow(request: Request) {
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)test_now=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}
export function database(env: Env, request: Request) {
  // Clock: TEST_CLOCK="1" lets a test_now cookie override it per request; else NOW var; else real time.
  const fixed = (env.TEST_CLOCK === "1" && testNow(request)) || env.NOW;
  const stmt = (sql: string, ...p: any[]) => env.DB.prepare(sql).bind(...p);
  return {
    one: async <T = any>(sql: string, ...p: any[]): Promise<T | undefined> => (await stmt(sql, ...p).first<T>()) ?? undefined,
    all: async <T = any>(sql: string, ...p: any[]): Promise<T[]> => (await stmt(sql, ...p).all<T>()).results,
    run: async (sql: string, ...p: any[]) => { const r = await stmt(sql, ...p).run(); return { lastInsertRowid: r.meta.last_row_id, changes: r.meta.changes }; },
    nowIso: () => fixed ? new Date(fixed).toISOString() : new Date().toISOString(),
  };
}
