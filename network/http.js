'use strict';

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
const TIMEOUT = 15000;

async function fetchPage(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS are supported');
  }

  if (url.username || url.password) {
    throw new Error('URLs containing credentials are not allowed');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'MAXBROWSER/0.1',
          'Accept': 'text/html,application/xhtml+xml,*/*'
        }
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');

        if (!location) {
          throw new Error('Redirect has no destination');
        }

        if (redirects === MAX_REDIRECTS) {
          throw new Error('Too many redirects');
        }

        url = new URL(location, url);

        if (!['http:', 'https:'].includes(url.protocol)) {
          throw new Error('Unsupported redirect protocol');
        }

        await response.body?.cancel();
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      const contentLength = Number(response.headers.get('content-length') || 0);

      if (contentLength > MAX_RESPONSE_SIZE) {
        await response.body?.cancel();
        throw new Error('Response exceeds 10 MB limit');
      }

      const reader = response.body?.getReader();

      if (!reader) {
        return {
          url: url.href,
          status: response.status,
          contentType,
          body: ''
        };
      }

      const chunks = [];
      let total = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) break;

          total += value.length;

          if (total > MAX_RESPONSE_SIZE) {
            await reader.cancel();
            throw new Error('Response exceeds 10 MB limit');
          }

          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      const bytes = Buffer.concat(chunks);
      const charset = contentType.match(/charset=["']?([^;"'\s]+)/i)?.[1] || 'utf-8';

      let body;

      try {
        body = new TextDecoder(charset).decode(bytes);
      } catch {
        body = bytes.toString('utf8');
      }

      return {
        url: url.href,
        status: response.status,
        contentType,
        size: bytes.length,
        body
      };
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Connection timed out after 15 seconds');
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }

  throw new Error('Unable to fetch page');
}

module.exports = { fetchPage };
