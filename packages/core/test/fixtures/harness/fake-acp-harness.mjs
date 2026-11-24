// A fake coding harness for test/harness.test.ts: an ACP agent over stdio
// (newline-delimited JSON-RPC 2.0, hand-written, no imports) that calls its
// model through ANTHROPIC_BASE_URL from its environment, as Claude Code does.
//
// The prompt text is a JSON script:
//   edits:   paths it asks permission to edit (kind 'edit'), one request each
//   reads:   paths it reads without asking (kind 'read'), reported only
//   calls:   model calls to make (POST <ANTHROPIC_BASE_URL>/v1/messages)
//   declare: USD it adds to its cumulative usage_update.cost
//   hang:    wait for session/cancel before answering
//   model:   the model it asks for (default claude-sonnet-4-5)
//   crash:   exit (code 7) without answering
//   switchMode: a mode it reports in a current_mode_update during the turn
//   echoMeta: reply with the session/new _meta and the session's mode as JSON
// session/set_mode accepts the modes 'default', 'plan' and 'bypassPermissions'.
// On a 402 it reports the refusal and waits up to 2 s for session/cancel, as a
// harness that would otherwise retry.

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const replyError = (id, error) =>
  write({
    jsonrpc: '2.0',
    id,
    error: { code: -32603, message: String(error && error.message ? error.message : error) },
  });
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });

let nextId = 1;
const pending = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = `h${nextId++}`;
    pending.set(id, resolve);
    write({ jsonrpc: '2.0', id, method, params });
  });

const sessions = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cancelled(session) {
  if (session.cancelled) return Promise.resolve();
  return new Promise((resolve) => session.onCancel.push(resolve));
}

async function prompt(message) {
  const { sessionId } = message.params;
  const session = sessions.get(sessionId);
  session.cancelled = false;
  const text = message.params.prompt
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
  const script = JSON.parse(text);
  if (script.crash) process.exit(7);
  const update = (value) => notify('session/update', { sessionId, update: value });
  const place = (path) =>
    path.startsWith('/') || /^[A-Za-z]:/.test(path) ? path : `${session.cwd}/${path}`;
  let n = 0;

  if (typeof script.switchMode === 'string') {
    session.mode = script.switchMode;
    update({ sessionUpdate: 'current_mode_update', currentModeId: script.switchMode });
  }
  if (script.echoMeta) {
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: JSON.stringify({ meta: session.meta, mode: session.mode }) },
    });
  }

  for (const path of script.edits ?? []) {
    const toolCallId = `edit-${++n}`;
    const location = { path: place(path) };
    update({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: `Edit ${path}`,
      kind: 'edit',
      status: 'pending',
      locations: [location],
    });
    const answer = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId, title: `Edit ${path}`, kind: 'edit', locations: [location] },
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'yes-always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const allowed =
      answer &&
      answer.outcome &&
      answer.outcome.outcome === 'selected' &&
      answer.outcome.optionId.startsWith('yes');
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: allowed ? 'completed' : 'failed',
    });
  }

  for (const path of script.reads ?? []) {
    const toolCallId = `read-${++n}`;
    update({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: `Read ${path}`,
      kind: 'read',
      status: 'completed',
      locations: [{ path: place(path) }],
    });
  }

  if (script.hang) {
    await cancelled(session);
    reply(message.id, { stopReason: 'cancelled' });
    return;
  }

  for (let call = 0; call < (script.calls ?? 0) && !session.cancelled; call++) {
    const response = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? 'test-key',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: script.model ?? 'claude-sonnet-4-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: `step ${call}` }],
      }),
    });
    const body = await response.json();
    if (response.status === 402) {
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `budget refused: ${body.error && body.error.type}` },
      });
      await Promise.race([cancelled(session), sleep(2000)]);
      break;
    }
    if (!response.ok) {
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `upstream error ${response.status}` },
      });
      break;
    }
    const reply = (body.content ?? []).map((part) => part.text ?? '').join('');
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } });
  }

  if (typeof script.declare === 'number') {
    session.cost += script.declare;
    update({
      sessionUpdate: 'usage_update',
      used: 1200,
      size: 200000,
      cost: { amount: session.cost, currency: 'USD' },
    });
  }
  reply(message.id, { stopReason: session.cancelled ? 'cancelled' : 'end_turn' });
}

function handle(message) {
  if (message.method === undefined && message.id !== undefined) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    if (resolve) resolve(message.result ?? { error: message.error });
    return;
  }
  switch (message.method) {
    case 'initialize':
      reply(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: {} },
        authMethods: [],
        agentInfo: { name: 'fake-harness', version: '1.0.0' },
      });
      return;
    case 'session/new': {
      const sessionId = `sess-${sessions.size + 1}`;
      sessions.set(sessionId, {
        cwd: String(message.params.cwd).replace(/\\/g, '/'),
        meta: message.params._meta ?? null,
        mode: 'auto',
        cost: 0,
        cancelled: false,
        onCancel: [],
      });
      reply(message.id, { sessionId });
      return;
    }
    case 'session/set_mode': {
      const session = sessions.get(message.params.sessionId);
      const modeId = message.params.modeId;
      if (!session || !['default', 'plan', 'bypassPermissions'].includes(modeId)) {
        write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32602, message: `Unknown mode ${modeId}` },
        });
        return;
      }
      session.mode = modeId;
      notify('session/update', {
        sessionId: message.params.sessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: modeId },
      });
      reply(message.id, {});
      return;
    }
    case 'session/prompt':
      prompt(message).catch((error) => replyError(message.id, error));
      return;
    case 'session/cancel': {
      const session = sessions.get(message.params.sessionId);
      if (session) {
        session.cancelled = true;
        for (const resolve of session.onCancel.splice(0)) resolve();
      }
      return;
    }
    default:
      if (message.id !== undefined)
        write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Method not found' },
        });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
    newline = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
