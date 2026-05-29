import { gzipSync } from 'zlib';
import { eq } from 'drizzle-orm';
import { settings } from '../db/schema';
import type { AppDatabase } from '../db/index';

export class DocumentStoreHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DocumentStoreHttpError';
    this.status = status;
  }
}

export class DocumentStore {
  constructor(private db: AppDatabase) {}

  private getBaseUrl(): string {
    const row = this.db.select().from(settings)
      .where(eq(settings.key, 'document_store_url')).all()[0];
    if (!row?.value) throw new Error('Document store URL not configured (set document_store_url in Settings)');
    return row.value.replace(/\/$/, '');
  }

  private getCustomHeaders(): Record<string, string> {
    const row = this.db.select().from(settings)
      .where(eq(settings.key, 'document_store_headers')).all()[0];
    if (!row?.value) return {};
    try {
      const parsed = JSON.parse(row.value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof k === 'string' && k.trim()) out[k] = String(v);
      }
      return out;
    } catch {
      return {};
    }
  }

  private buildHeaders(defaults: Record<string, string>): Record<string, string> {
    return { ...defaults, ...this.getCustomHeaders() };
  }

  async getDoc(docId: string): Promise<any> {
    const resp = await fetch(`${this.getBaseUrl()}/id/${encodeURIComponent(docId)}`, {
      method: 'GET',
      headers: this.buildHeaders({ 'Content-Type': 'application/json' }),
    });
    if (!resp.ok) throw new DocumentStoreHttpError(resp.status, `Document store GET failed: ${resp.status}`);
    return resp.json();
  }

  async putDoc(docId: string, doc: any): Promise<any> {
    const body = gzipSync(JSON.stringify(doc), { level: 9 });
    const resp = await fetch(`${this.getBaseUrl()}/id/${encodeURIComponent(docId)}`, {
      method: 'PUT',
      headers: this.buildHeaders({ 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }),
      body,
    });
    if (!resp.ok) throw new DocumentStoreHttpError(resp.status, `Document store PUT failed: ${resp.status}`);
    return resp.json();
  }
}
