// Minimal JSON-over-HTTP helper for FluxOS node APIs.
// FluxOS wraps every daemon RPC as { status: 'success' | 'error', data }.

export class NodeError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'timeout' | 'http' | 'network' | 'rpc' | 'parse'
  }
}

export async function getJson(url, { timeoutMs = 8000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'FluxFlow-PoC/0.1 (+https://github.com/2ndtlmining/fluxflow)' },
    });
  } catch (err) {
    const kind = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'network';
    throw new NodeError(kind, `${kind}: ${err.cause?.code || err.message}`);
  }
  if (!res.ok) throw new NodeError('http', `HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new NodeError('parse', 'invalid JSON');
  }
  return body;
}

// Call a FluxOS /daemon/* route and unwrap the envelope.
export async function fluxos(baseUrl, path, opts) {
  const body = await getJson(`${baseUrl}${path}`, opts);
  if (body && body.status === 'success') return body.data;
  if (body && body.status === 'error') {
    throw new NodeError('rpc', body.data?.message || 'rpc error');
  }
  // Some explorer endpoints return raw JSON without the envelope.
  return body;
}
