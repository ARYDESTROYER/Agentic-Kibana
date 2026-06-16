import type { CoreStart } from '@kbn/core/public';
import { PROXY_BASE } from '../../common';

/**
 * Thin wrapper over core.http that routes every call through the in-Kibana
 * proxy (`/api/tlsoc/...`). The browser never talks to the backend directly.
 */
export class TlsocApi {
  constructor(private readonly http: CoreStart['http']) {}

  private path(p: string): string {
    const clean = p.replace(/^\/+/, '');
    return `${PROXY_BASE}/${clean}`;
  }

  async get<T = any>(p: string, query?: Record<string, any>): Promise<T> {
    return this.http.get<T>(this.path(p), { query });
  }

  async post<T = any>(p: string, body?: unknown): Promise<T> {
    return this.http.post<T>(this.path(p), {
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async put<T = any>(p: string, body?: unknown): Promise<T> {
    return this.http.put<T>(this.path(p), {
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}
