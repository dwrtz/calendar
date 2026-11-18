// The unit tests run Worker modules (slot logic) on Node against a D1-shaped SQLite shim, so they only need the
// bindings' shape loosely. The real Env type is worker-env.d.ts, checked by tsconfig.worker.json.
interface TestD1Statement { bind(...p: any[]): TestD1Statement; first<T = any>(): Promise<T | null>; all<T = any>(): Promise<{ results: T[] }>; run(): Promise<{ meta: { changes: number; last_row_id: number } }> }
declare type Env = { DB: { prepare(sql: string): TestD1Statement; batch(list: TestD1Statement[]): Promise<any[]> }; [key: string]: any };
