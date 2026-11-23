'use strict';

// MAXBROWSER — guarded network access for page JavaScript.
// Page scripts may not reach localhost, private ranges, file:// or the
// Termux filesystem. Every request is size-capped and time-limited.

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15000;

function isBlockedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');

  if (!host) return true;
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '::') return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);

    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
  }

  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;

  return false;
}

function assertAllowed(rawUrl) {
  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('invalid URL: ' + rawUrl);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('blocked protocol: ' + parsed.protocol);
  }

  if (parsed.username || parsed.password) {
    throw new Error('credentials in URL are not allowed');
  }

  if (isBlockedHost(parsed.hostname)) {
    throw new Error('blocked host (private or loopback): ' + parsed.hostname);
  }

  return parsed;
}

async function readCapped(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.subarray(0, maxBytes).toString('utf8');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;

    if (total > maxBytes) {
      chunks.push(Buffer.from(value).subarray(0, Math.max(0, maxBytes - (total - value.byteLength))));
      truncated = true;
      try { await reader.cancel(); } catch { /* stream already closing */ }
      break;
    }

    chunks.push(Buffer.from(value));
  }

  const text = Buffer.concat(chunks).toString('utf8');
  return truncated ? text + '\n[response truncated at ' + maxBytes + ' bytes]' : text;
}

async function safeFetch(rawUrl, options = {}) {
  const parsed = assertAllowed(rawUrl);

  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  const maxBytes = options.maxBytes || MAX_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const method = String(options.method || 'GET').toUpperCase();

  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'].includes(method)) {
    clearTimeout(timer);
    throw new Error('blocked method: ' + method);
  }

  try {
    const response = await fetch(parsed.href, {
      method,
      headers: options.headers || {},
      body: method === 'GET' || method === 'HEAD' ? undefined : (options.body || undefined),
      redirect: 'follow',
      signal: controller.signal
    });

    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });

    const body = method === 'HEAD' ? '' : await readCapped(response, maxBytes);

    return {
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
      redirected: response.redirected
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { safeFetch, isBlockedHost, assertAllowed, MAX_BYTES, TIMEOUT_MS };
