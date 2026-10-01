const MAX_RETRIES = 5;

/**
 * fetch + JSON with exponential backoff on 429 / 5xx / network errors.
 * Other 4xx errors fail immediately (bad key, bad request).
 */
export async function requestJsonWithRetry<T>(
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: unknown },
  label: string
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 30_000));
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        headers: {
          ...init.headers,
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (err) {
      lastError = err;
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
    const errText = await res.text();
    const path = new URL(url).pathname;
    lastError = new Error(`${label} API error (HTTP ${res.status}) on ${path}: ${errText.slice(0, 500)}`);
    if (res.status !== 429 && res.status < 500) break;
  }
  throw lastError;
}

export function postJsonWithRetry<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  label: string
): Promise<T> {
  return requestJsonWithRetry<T>(url, { method: "POST", headers, body }, label);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
