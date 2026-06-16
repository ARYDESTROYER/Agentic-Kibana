import { schema } from '@kbn/config-schema';
import { IRouter, Logger } from '../../../../src/core/server';

/**
 * Build the upstream URL for a forwarded request.
 *
 * The browser calls e.g. `GET /api/tlsoc/health` -> Kibana -> backend
 * `GET ${backendUrl}/api/health`.
 */
function buildTargetUrl(backendUrl: string, path: string, queryString: string): string {
  const base = backendUrl.replace(/\/+$/, '');
  const cleanPath = (path || '').replace(/^\/+/, '');
  const qs = queryString ? `?${queryString}` : '';
  return `${base}/api/${cleanPath}${qs}`;
}

/**
 * Reconstruct a query string from Kibana's parsed query object.
 */
function toQueryString(query: unknown): string {
  if (!query || typeof query !== 'object') {
    return '';
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const v of value) {
        params.append(key, String(v));
      }
    } else {
      params.append(key, String(value));
    }
  }
  return params.toString();
}

export function defineRoutes(router: IRouter, backendUrl: string, logger: Logger) {
  const pathValidation = {
    params: schema.object({
      path: schema.maybe(schema.string()),
    }),
    query: schema.maybe(schema.recordOf(schema.string(), schema.any())),
  };

  // ----- GET -----
  router.get(
    {
      path: '/api/tlsoc/{path*}',
      validate: pathValidation,
    },
    async (context, request, response) => {
      return forward('GET', router, backendUrl, logger, request, response);
    }
  );

  // ----- POST -----
  router.post(
    {
      path: '/api/tlsoc/{path*}',
      validate: {
        ...pathValidation,
        body: schema.maybe(schema.any()),
      },
      options: { body: { parse: true, maxBytes: 26214400 } },
    },
    async (context, request, response) => {
      return forward('POST', router, backendUrl, logger, request, response);
    }
  );

  // ----- PUT -----
  router.put(
    {
      path: '/api/tlsoc/{path*}',
      validate: {
        ...pathValidation,
        body: schema.maybe(schema.any()),
      },
      options: { body: { parse: true, maxBytes: 26214400 } },
    },
    async (context, request, response) => {
      return forward('PUT', router, backendUrl, logger, request, response);
    }
  );
}

async function forward(
  method: 'GET' | 'POST' | 'PUT',
  _router: IRouter,
  backendUrl: string,
  logger: Logger,
  request: any,
  response: any
) {
  const path = request.params?.path ?? '';
  const queryString = toQueryString(request.query);
  const target = buildTargetUrl(backendUrl, path, queryString);

  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | undefined;
  if (method !== 'GET' && request.body !== undefined && request.body !== null) {
    body = JSON.stringify(request.body);
    headers['content-type'] = 'application/json';
  }

  try {
    // Node 18 global fetch.
    const upstream = await fetch(target, { method, headers, body });
    const text = await upstream.text();

    let parsed: unknown = text;
    const contentType = upstream.headers.get('content-type') || '';
    if (contentType.includes('application/json') || (text && text.trim().startsWith('{')) || (text && text.trim().startsWith('['))) {
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = text;
      }
    }

    return response.custom({
      statusCode: upstream.status,
      body: parsed as any,
    });
  } catch (err) {
    logger.error(`tlsocAgenticTriage proxy error for ${method} ${target}: ${(err as Error).message}`);
    return response.custom({
      statusCode: 502,
      body: {
        error: 'bad_gateway',
        message: `Failed to reach TLSOC backend at ${target}: ${(err as Error).message}`,
      },
    });
  }
}
