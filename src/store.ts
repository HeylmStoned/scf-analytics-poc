import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { bucketIndex, emptyCounts, LATENCY_BUCKETS_MS, percentile } from './histogram.ts';

export type ApiRow = {
  tenantId: string;
  serviceName: string;
  route: string;
  statusCode: number;
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
};

export type WebRow = {
  tenantId: string;
  path: string;
  views: number;
};

export type Principal = { role: 'operator' } | { role: 'tenant'; tenantId: string };

type ApiKey = {
  tenantId: string;
  serviceName: string;
  route: string;
  statusCode: number;
  hour: string;
  counts: number[];
};

function hourKey(date = new Date()): string {
  const copy = new Date(date);
  copy.setUTCMinutes(0, 0, 0);
  return copy.toISOString();
}

function dayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(24).toString('hex');
}

export class MemoryStore {
  private readonly tokens = new Map<string, Principal>();
  private readonly api = new Map<string, ApiKey>();
  private readonly web = new Map<string, number>();

  constructor(operatorToken: string) {
    this.tokens.set(hashToken(operatorToken), { role: 'operator' });
  }

  principal(token: string | undefined): Principal | undefined {
    if (!token) return undefined;
    return this.tokens.get(hashToken(token));
  }

  addTenant(id: string, token = newToken()): string {
    this.tokens.set(hashToken(token), { role: 'tenant', tenantId: id });
    return token;
  }

  addApi(row: { tenantId: string; serviceName: string; route: string; statusCode: number; durationMs: number }, at = new Date()): void {
    const hour = hourKey(at);
    const key = [row.tenantId, row.serviceName, row.route, row.statusCode, hour].join('|');
    const existing = this.api.get(key) ?? {
      tenantId: row.tenantId,
      serviceName: row.serviceName,
      route: row.route,
      statusCode: row.statusCode,
      hour,
      counts: emptyCounts(),
    };
    const index = bucketIndex(row.durationMs);
    existing.counts[index] = (existing.counts[index] ?? 0) + 1;
    this.api.set(key, existing);
  }

  addPageview(tenantId: string, path: string): void {
    const key = `${tenantId}|${dayKey()}|${path}`;
    this.web.set(key, (this.web.get(key) ?? 0) + 1);
  }

  apiRows(tenantId?: string): ApiRow[] {
    const grouped = new Map<string, { row: Omit<ApiRow, 'count' | 'p50Ms' | 'p95Ms'>; counts: number[] }>();
    for (const entry of this.api.values()) {
      if (tenantId && entry.tenantId !== tenantId) continue;
      const key = [entry.tenantId, entry.serviceName, entry.route, entry.statusCode].join('|');
      const existing = grouped.get(key) ?? {
        row: {
          tenantId: entry.tenantId,
          serviceName: entry.serviceName,
          route: entry.route,
          statusCode: entry.statusCode,
        },
        counts: emptyCounts(),
      };
      existing.counts = existing.counts.map((count, index) => count + (entry.counts[index] ?? 0));
      grouped.set(key, existing);
    }
    return [...grouped.values()].map(({ row, counts }) => ({
      ...row,
      count: counts.reduce((sum, count) => sum + count, 0),
      p50Ms: percentile(counts, 50),
      p95Ms: percentile(counts, 95),
    }));
  }

  webRows(tenantId?: string): WebRow[] {
    const rows: WebRow[] = [];
    for (const [key, views] of this.web) {
      const [owner, , path] = key.split('|');
      if (!owner || path === undefined) continue;
      if (tenantId && owner !== tenantId) continue;
      rows.push({ tenantId: owner, path, views });
    }
    return rows;
  }
}

export class PgStore {
  constructor(private readonly pool: pg.Pool) {}

  static async connect(connectionString: string, operatorToken: string): Promise<PgStore> {
    const pool = new pg.Pool({ connectionString });
    const store = new PgStore(pool);
    await store.ensureSchema(operatorToken);
    return store;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async ensureSchema(operatorToken: string): Promise<void> {
    await this.pool.query(`
      create table if not exists principals (
        token_hash text primary key,
        role text not null,
        tenant_id text
      );
      create table if not exists api_bucket (
        tenant_id text not null,
        service_name text not null,
        route text not null,
        status_code int not null,
        hour timestamptz not null,
        le_ms int not null,
        request_count bigint not null,
        primary key (tenant_id, service_name, route, status_code, hour, le_ms)
      );
      create table if not exists web_daily (
        tenant_id text not null,
        day date not null,
        path text not null,
        views bigint not null,
        primary key (tenant_id, day, path)
      );
    `);
    await this.pool.query(
      `insert into principals (token_hash, role) values ($1, 'operator')
       on conflict (token_hash) do nothing`,
      [hashToken(operatorToken)],
    );
  }

  async principal(token: string | undefined): Promise<Principal | undefined> {
    if (!token) return undefined;
    const result = await this.pool.query<{ role: string; tenant_id: string | null }>(
      'select role, tenant_id from principals where token_hash = $1',
      [hashToken(token)],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.role === 'operator') return { role: 'operator' };
    if (row.tenant_id) return { role: 'tenant', tenantId: row.tenant_id };
    return undefined;
  }

  async addTenant(id: string, token = newToken()): Promise<string> {
    await this.pool.query(
      `insert into principals (token_hash, role, tenant_id) values ($1, 'tenant', $2)
       on conflict (token_hash) do nothing`,
      [hashToken(token), id],
    );
    return token;
  }

  async addApi(row: { tenantId: string; serviceName: string; route: string; statusCode: number; durationMs: number }, at = new Date()): Promise<void> {
    const hour = hourKey(at);
    const le = LATENCY_BUCKETS_MS[bucketIndex(row.durationMs)];
    await this.pool.query(
      `insert into api_bucket (tenant_id, service_name, route, status_code, hour, le_ms, request_count)
       values ($1, $2, $3, $4, $5, $6, 1)
       on conflict (tenant_id, service_name, route, status_code, hour, le_ms)
       do update set request_count = api_bucket.request_count + 1`,
      [row.tenantId, row.serviceName, row.route, row.statusCode, hour, le],
    );
  }

  async addPageview(tenantId: string, path: string): Promise<void> {
    await this.pool.query(
      `insert into web_daily (tenant_id, day, path, views) values ($1, $2, $3, 1)
       on conflict (tenant_id, day, path) do update set views = web_daily.views + 1`,
      [tenantId, dayKey(), path],
    );
  }

  async apiRows(tenantId?: string): Promise<ApiRow[]> {
    const result = await this.pool.query<{
      tenant_id: string;
      service_name: string;
      route: string;
      status_code: number;
      le_ms: number;
      request_count: string;
    }>(
      `select tenant_id, service_name, route, status_code, le_ms, sum(request_count)::text as request_count
       from api_bucket
       where ($1::text is null or tenant_id = $1)
       group by tenant_id, service_name, route, status_code, le_ms`,
      [tenantId ?? null],
    );
    const grouped = new Map<string, { row: Omit<ApiRow, 'count' | 'p50Ms' | 'p95Ms'>; counts: number[] }>();
    for (const entry of result.rows) {
      const key = [entry.tenant_id, entry.service_name, entry.route, entry.status_code].join('|');
      const existing = grouped.get(key) ?? {
        row: {
          tenantId: entry.tenant_id,
          serviceName: entry.service_name,
          route: entry.route,
          statusCode: entry.status_code,
        },
        counts: emptyCounts(),
      };
      const index = LATENCY_BUCKETS_MS.indexOf(entry.le_ms as (typeof LATENCY_BUCKETS_MS)[number]);
      if (index >= 0) existing.counts[index] = Number(entry.request_count);
      grouped.set(key, existing);
    }
    return [...grouped.values()].map(({ row, counts }) => ({
      ...row,
      count: counts.reduce((sum, count) => sum + count, 0),
      p50Ms: percentile(counts, 50),
      p95Ms: percentile(counts, 95),
    }));
  }

  async webRows(tenantId?: string): Promise<WebRow[]> {
    const result = await this.pool.query<{ tenant_id: string; path: string; views: string }>(
      `select tenant_id, path, sum(views)::text as views
       from web_daily
       where ($1::text is null or tenant_id = $1)
       group by tenant_id, path`,
      [tenantId ?? null],
    );
    return result.rows.map((row) => ({ tenantId: row.tenant_id, path: row.path, views: Number(row.views) }));
  }
}

export type Store = MemoryStore | PgStore;
