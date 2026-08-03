import { Injectable, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';

export interface EndpointProbe {
  status: number;
  /** 2xx — the endpoint served a full successful response. */
  ok: boolean;
  /** status < 500 — the endpoint is reachable and responded correctly, even if
   *  it returned 4xx because the unattended probe omitted required query params.
   *  Only 5xx / network errors (up === false) are a genuine outage. */
  up: boolean;
  ms: number;
  error?: string;
}
export interface EndpointRow {
  method: string;
  path: string;
  controller: string;
  guarded: boolean;
  probe: EndpointProbe | { skipped: true; reason: string };
}
export interface ApiHealthReport {
  service: string;
  generatedAt: string;
  summary: {
    total: number;
    byMethod: Record<string, number>;
    probed: number;
    /** 2xx responses. */
    ok: number;
    /** reachable but 4xx (needs params/body) — not an outage. */
    needsInput: number;
    /** 5xx or network error — a genuine failure. */
    down: number;
    skipped: number;
  };
  endpoints: EndpointRow[];
}

/**
 * Enumerates every HTTP route registered in THIS running service (via Nest's
 * DiscoveryService + reflected route metadata — version-stable, unlike poking
 * the Express router internals) and health-checks the ones that are safe to
 * call unattended: public GETs with no path param or wildcard.
 *
 * Guarded / mutating / parameterised routes are listed but not probed (a probe
 * would need a token or would have side effects) — each carries a reason, so
 * the admin sees the full inventory and exactly what was and wasn't verified.
 */
@Injectable()
export class ApiHealthService {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  listEndpoints(): Array<{
    method: string;
    path: string;
    controller: string;
    guarded: boolean;
  }> {
    const rows: Array<{
      method: string;
      path: string;
      controller: string;
      guarded: boolean;
    }> = [];

    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      const metatype = wrapper.metatype as (new (...a: unknown[]) => unknown) | undefined;
      if (!instance || !metatype) continue;

      const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
      const ctrlPath = this.reflector.get<string>(PATH_METADATA, metatype) ?? '';
      const classGuards = this.reflector.get<unknown[]>(GUARDS_METADATA, metatype);

      const names =
        typeof this.scanner.getAllMethodNames === 'function'
          ? this.scanner.getAllMethodNames(proto)
          : Object.getOwnPropertyNames(proto);

      for (const name of names) {
        const handler = proto[name];
        if (typeof handler !== 'function') continue;
        const methodPath = this.reflector.get<string | undefined>(PATH_METADATA, handler);
        const httpMethod = this.reflector.get<number | undefined>(METHOD_METADATA, handler);
        if (methodPath === undefined || httpMethod === undefined) continue;
        const methodGuards = this.reflector.get<unknown[]>(GUARDS_METADATA, handler);

        rows.push({
          method: RequestMethod[httpMethod] ?? String(httpMethod),
          path: this.joinPath(ctrlPath, methodPath),
          controller: metatype.name,
          guarded: !!(classGuards?.length || methodGuards?.length),
        });
      }
    }

    return rows.sort(
      (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
    );
  }

  private joinPath(a: string, b: string): string {
    const strip = (s: string) => (s || '').replace(/^\/+|\/+$/g, '');
    const joined = [strip(a), strip(b)].filter(Boolean).join('/');
    return '/' + joined;
  }

  async check(): Promise<ApiHealthReport> {
    const endpoints = this.listEndpoints();
    const port = Number(this.config.get('PORT', 4400)) || 4400;
    const base = `http://127.0.0.1:${port}`;

    const rows: EndpointRow[] = await Promise.all(
      endpoints.map(async (e): Promise<EndpointRow> => {
        const probeable =
          e.method === 'GET' &&
          !e.guarded &&
          !e.path.includes(':') &&
          !e.path.includes('*');

        if (!probeable) {
          const reason =
            e.method !== 'GET'
              ? `mutating (${e.method})`
              : e.guarded
                ? 'requires auth'
                : e.path.includes(':')
                  ? 'needs path param'
                  : 'wildcard route';
          return { ...e, probe: { skipped: true, reason } };
        }

        const started = Date.now();
        try {
          const res = await fetch(base + e.path, { method: 'GET' });
          const status = res.status;
          return {
            ...e,
            probe: {
              status,
              ok: status >= 200 && status < 300,
              // 4xx = the endpoint is up and validated the request (the probe
              // just omitted required params); only 5xx is a real outage.
              up: status < 500,
              ms: Date.now() - started,
            },
          };
        } catch (err) {
          return {
            ...e,
            probe: {
              status: 0,
              ok: false,
              up: false,
              ms: Date.now() - started,
              error: (err as Error).message,
            },
          };
        }
      }),
    );

    const byMethod: Record<string, number> = {};
    for (const e of endpoints) byMethod[e.method] = (byMethod[e.method] ?? 0) + 1;
    const probedRows = rows.filter((r) => !('skipped' in r.probe));
    const okCount = probedRows.filter((r) => (r.probe as EndpointProbe).ok).length;
    const upCount = probedRows.filter((r) => (r.probe as EndpointProbe).up).length;

    const role = String(this.config.get('APP_ROLE', 'worker')).toLowerCase();
    return {
      service: role === 'live' ? 'market-catalyst-live' : 'market-catalyst-backend',
      generatedAt: new Date().toISOString(),
      summary: {
        total: endpoints.length,
        byMethod,
        probed: probedRows.length,
        ok: okCount,
        needsInput: upCount - okCount,
        down: probedRows.length - upCount,
        skipped: rows.length - probedRows.length,
      },
      endpoints: rows,
    };
  }
}
