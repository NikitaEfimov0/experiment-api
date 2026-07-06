'use strict';

// HTTP client for the Raspberry Pi recording agent (see INTEGRATION.md).
// The Pi exposes /health, /status, /recording/start, /recording/stop.

class PiAgentError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status; // HTTP status to surface to the API client
  }
}

function createPiAgent({ baseUrl, startTimeoutMs = 20000, stopTimeoutMs = 60000 }) {
  const url = baseUrl.replace(/\/+$/, '');

  async function call(method, path, body, timeoutMs) {
    let res;
    try {
      res = await fetch(url + path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? 'timed out' : err.message;
      throw new PiAgentError(`Recording agent unreachable (${method} ${path}: ${reason})`, 502);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Map the Pi's 409 (busy / not recording) through; everything else -> 502.
      const status = res.status === 409 ? 409 : 502;
      throw new PiAgentError(json.error || `Recording agent error (HTTP ${res.status})`, status);
    }
    return json;
  }

  return {
    /** Pi camera warm-up takes ~1-4s (worst case ~18s); returns once truly recording. */
    startRecording: (exerciseId) => call('POST', '/recording/start', { exerciseId }, startTimeoutMs),
    /** On stop the Pi finalises files and uploads them to us before responding. */
    stopRecording: () => call('POST', '/recording/stop', undefined, stopTimeoutMs),
    status: () => call('GET', '/status', undefined, 5000),
    health: () => call('GET', '/health', undefined, 5000),
  };
}

module.exports = { createPiAgent, PiAgentError };
