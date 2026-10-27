// The Ask panel's server half (services/assistant.js): what Claude is sent, and
// that the streamed answer comes through. Runs without an API key — the
// Anthropic client is swapped for a stand-in that replays a canned stream.

const assistant = require('../services/assistant');
const accessControl = require('../services/accessControl');

let failed = 0;
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}

const ctx = { page: 'variances', label: 'Willow Creek · Repairs · Sep 26', text: 'OPEN VARIANCE FLAG\nLine: Repairs\nThis month: $48,200.00' };

// ── What goes to Claude ───────────────────────────────────────────────────────
const history = [
  { role: 'user', text: 'Why did repairs jump?' },
  { role: 'assistant', text: 'A $31K boiler invoice from Acme posted in September.' },
];
const msgs = assistant.buildMessages(history, 'Is that one-time?', ctx);
check('earlier turns go as plain question and answer', msgs[0].content === 'Why did repairs jump?' && msgs[1].role === 'assistant');
check('only the latest question carries the page', msgs.filter(m => String(m.content).includes('<page')).length === 1
  && msgs[2].content.includes('<page tab="variances" focus="Willow Creek · Repairs · Sep 26">') && msgs[2].content.endsWith('Is that one-time?'));
check('the page text reaches Claude', msgs[2].content.includes('This month: $48,200.00'));

const long = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `turn ${i}` }));
const trimmed = assistant.buildMessages(long, 'q', ctx);
check('a long conversation keeps its last 12 messages plus the question', trimmed.length === 13 && trimmed[0].role === 'user');
const oddStart = assistant.buildMessages(long.slice(1, 14), 'q', ctx);
check('a trimmed history never opens on an answer', oddStart[0].role === 'user');
check('junk history entries are dropped', assistant.buildMessages([{ role: 'system', text: 'x' }, null, { role: 'user' }], 'q', ctx).length === 1);

const big = assistant.pageBlock({ page: 'overview', text: 'x'.repeat(assistant.MAX_CONTEXT_CHARS + 500) });
check('an oversized page is cut and says so', big.includes('the rest was not sent') && big.length < assistant.MAX_CONTEXT_CHARS + 400);
check('a hostile tab name cannot break out of the page tag', !assistant.pageBlock({ page: '"><x', text: 't' }).includes('"><x'));

// ── The stream ────────────────────────────────────────────────────────────────
function fakeApi(chunks, stopReason, sink) {
  return { beta: { messages: { stream(params) {
    sink.params = params;
    return {
      async *[Symbol.asyncIterator]() {
        for (const text of chunks) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
      },
      async finalMessage() { return { stop_reason: stopReason, model: params.model, usage: { input_tokens: 10, output_tokens: 5 } }; },
    };
  } } } };
}

(async () => {
  const sink = {};
  let got = '';
  const r = await assistant.streamAnswer({ history: [], question: 'Why?', context: ctx, api: fakeApi(['A boiler ', 'invoice.'], 'end_turn', sink), onText: t => { got += t; } });
  check('streamed text arrives in order', got === 'A boiler invoice.');
  check('the stop reason is passed back', r.stopReason === 'end_turn');
  check('asks Sonnet 5.5 with refusal fallbacks on', sink.params.model === 'claude-sonnet-5-5'
    && sink.params.fallbacks === 'default' && sink.params.betas.includes('server-side-fallback-2026-07-01'));
  check('the system prompt is cached', sink.params.system[0].cache_control && sink.params.system[0].cache_control.type === 'ephemeral');

  // ── Access ──────────────────────────────────────────────────────────────────
  const person = { admin: false, tools: ['variances'] };
  check('any signed-in person may ask', accessControl.decide(person, 'POST', '/api/assistant').ok);
  check('nobody signed out may ask', !accessControl.decide(null, 'POST', '/api/assistant').ok);

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll Ask panel checks pass');
  process.exit(failed ? 1 : 0);
})();
