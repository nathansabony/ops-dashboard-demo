// Streaming Messages helper for services (the contract scanner). server.js still
// carries its own identical copy for the underwriting extractors.
// Streaming Messages call — rent-roll extractions can emit 30-60K output
// tokens (every unit as JSON), far past what a non-streaming request allows
// without HTTP timeouts. Accumulates text deltas + usage, returns like the
// non-streaming shape: { text, usage }.
async function anthropicStreamText(apiKey, payload, timeoutMs = 600000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ ...payload, stream: true }),
      signal: ctrl.signal,
    });
    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      const e = new Error(err.error?.message || `Anthropic API error (${upstream.status})`);
      e.status = upstream.status;
      throw e;
    }
    let text = '';
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    let stopReason = null;
    let buf = '';
    const decoder = new TextDecoder();
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(dataStr); } catch { continue; }
        if (ev.type === 'message_start' && ev.message?.usage) {
          Object.assign(usage, ev.message.usage);
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          text += ev.delta.text;
        } else if (ev.type === 'message_delta') {
          if (ev.usage?.output_tokens != null) usage.output_tokens = ev.usage.output_tokens;
          if (ev.usage?.server_tool_use?.web_search_requests != null) usage.web_search_requests = ev.usage.server_tool_use.web_search_requests;
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        } else if (ev.type === 'error') {
          throw new Error(ev.error?.message || 'Anthropic stream error');
        }
      }
    }
    return { text, usage, stopReason };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { anthropicStreamText };
