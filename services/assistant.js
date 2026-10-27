// The "Ask" panel: questions about whatever the person has open (2026-10-20).
//
// The browser sends what is on screen — the open variance flag with its monthly
// history and the postings under it, the Overview alert feed, a tab's tables —
// and Claude answers from that. It is given nothing the page does not already
// show, so per-person tool access (services/accessControl.js) carries over by
// construction: a person can only ask about data the server already let them see.
//
// Only the latest question carries the page. Earlier turns are kept as plain
// question and answer, so a long conversation does not resend every screen it
// passed through, and "and the month before?" still reads against what was said.

const Anthropic = require('@anthropic-ai/sdk');
const assistantTools = require('./assistantTools');

const MODEL = 'claude-sonnet-5-5';
const MAX_QUESTION_CHARS = 4000;
const MAX_CONTEXT_CHARS = 60000;
const MAX_HISTORY_MESSAGES = 12;   // six back-and-forths

const SYSTEM_PROMPT = `You are the analyst built into the Cedar Ridge Management site. Cedar Ridge manages a multifamily portfolio in Columbus, Ohio, held in one ownership entity (Cedar Ridge) of five Columbus properties. The books are in Rent Manager, and the site reads them live.

Each question arrives with a <page> block: the tab the person has open and what it shows. That may be a variance flag with its monthly history and the GL postings behind it, the Overview alert feed, a delinquency table, a budget, and so on.

You may also have lookup tools that read the site's data beyond the open page: any building's or entity's P&L by month, rankings across buildings, the GL postings behind a line, delinquency, collections, occupancy, budgets, work orders, duplicate payments, renovation spend, debt service, move activity and the open variance flags. They only offer what this person has access to.
- Answer from the page when it already has what the question needs. Use the tools when it does not, or to check, compare or go a level deeper.
- Find the exact building with list_properties before other lookups when the name is ambiguous. Check line keys with pl_lines when unsure.
- gl_postings pulls live from Rent Manager and takes several seconds. Use it to explain a specific line in a specific month, with a tight window.
- Most other tools read snapshots the site refreshes daily or weekly. Mention the as-of date when the age matters.
- Several lookups can run in one step; ask for them together when they do not depend on each other.

How to answer:
- Lead with the answer in a sentence or two, then the figures that support it. Name months, buildings, accounts, vendors and amounts as they appear in the data.
- When neither the page nor the tools have what the question needs, say what is missing and where to find it (which tab, or which Rent Manager report or screen). Never invent figures, postings, vendors or dates.
- For a jump or drop, separate the likely causes: a one-time or catch-up bill, a billing lag (utility bills often post a month or two after the service period), a posting to the wrong account or building, a duplicate, a credit or reversal, or a real change in the run rate. Say which the data supports and what would confirm it.
- Suggest a concrete next step when there is one: the posting to open, the bill to pull, who to ask.
- Write for a property-management analyst. Plain words, short paragraphs, a short list when it helps. No headings. Keep it under about 250 words unless asked for more.`;

let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

function isConfigured() {
  return Boolean((process.env.ANTHROPIC_API_KEY || '').trim());
}

// Cap the page snapshot, and say so in the block itself when it was cut, so a
// missing table reads as "not sent" rather than "not there".
function pageBlock(context) {
  const page = String((context && context.page) || 'unknown').replace(/[^\w -]/g, '');
  const label = String((context && context.label) || '').slice(0, 200);
  let text = String((context && context.text) || '').trim();
  let note = '';
  if (text.length > MAX_CONTEXT_CHARS) {
    text = text.slice(0, MAX_CONTEXT_CHARS);
    note = `\n[The page was longer than ${MAX_CONTEXT_CHARS.toLocaleString()} characters; the rest was not sent.]`;
  }
  return `<page tab="${page}"${label ? ` focus="${label.replace(/"/g, "'")}"` : ''}>\n${text || '(nothing readable on this page yet)'}${note}\n</page>`;
}

// history: [{ role: 'user' | 'assistant', text }], oldest first, not including
// the question being asked now. Returns the Messages API `messages` array.
function buildMessages(history, question, context) {
  const turns = (Array.isArray(history) ? history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .slice(-MAX_HISTORY_MESSAGES)
    .map(m => ({ role: m.role, content: m.text.slice(0, MAX_QUESTION_CHARS * 2) }));
  // The conversation must open on a user turn; a trimmed history can start on an answer.
  while (turns.length && turns[0].role !== 'user') turns.shift();
  turns.push({ role: 'user', content: `${pageBlock(context)}\n\n${String(question).slice(0, MAX_QUESTION_CHARS)}` });
  return turns;
}

// Streams the answer as text chunks to onText, running lookup tools as Claude
// asks for them (services/assistantTools.js). onStatus hears what is being looked
// up. Resolves { stopReason, usage, model, toolCalls }.
// `api` is injectable so the check scripts can run without a key.
const MAX_TOOL_ROUNDS = 8;
async function streamAnswer({ history, question, context, onText, onStatus, signal, api, user, sources, flags }) {
  const tools = user && sources ? assistantTools.toolsFor(user) : [];
  const messages = buildMessages(history, question, context);
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const toolCalls = [];
  let last = null;

  for (let round = 0; ; round++) {
    // The last round may not call tools, so a question that keeps reaching for
    // more data still ends in an answer from what was gathered. (The tools stay
    // defined: the history holds tool calls, which the API requires them for.)
    const finalRound = round >= MAX_TOOL_ROUNDS;
    const stream = (api || client()).beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      // A declined answer is re-run on Anthropic's recommended fallback model
      // instead of coming back empty.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      ...(tools.length ? { tools, ...(finalRound ? { tool_choice: { type: 'none' } } : {}) } : {}),
      messages,
    }, signal ? { signal } : undefined);

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onText(event.delta.text);
    }
    last = await stream.finalMessage();
    for (const k of Object.keys(usage)) usage[k] += (last.usage && last.usage[k]) || 0;

    if (last.stop_reason !== 'tool_use') break;
    const calls = last.content.filter(b => b.type === 'tool_use');
    if (!calls.length) break;

    // The whole turn goes back unchanged (thinking blocks included), then every
    // result in one user message.
    messages.push({ role: 'assistant', content: last.content });
    const results = await Promise.all(calls.map(async call => {
      if (onStatus) onStatus(assistantTools.describeCall(call.name, call.input));
      const t0 = Date.now();
      const r = await assistantTools.runTool(call.name, call.input, { user, sources, flags });
      toolCalls.push({ name: call.name, ms: Date.now() - t0, error: r.isError || undefined });
      return { type: 'tool_result', tool_use_id: call.id, content: r.content, ...(r.isError ? { is_error: true } : {}) };
    }));
    messages.push({ role: 'user', content: results });
    // Keep the answer's paragraphs apart from what was said before the lookup.
    onText('\n\n');
  }
  return { stopReason: last.stop_reason, usage, model: last.model, toolCalls };
}

module.exports = { MODEL, MAX_QUESTION_CHARS, MAX_CONTEXT_CHARS, isConfigured, buildMessages, pageBlock, streamAnswer };
