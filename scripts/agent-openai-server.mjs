// A single Codex backend, serving the text subset of the OpenAI Responses API.
// Start through local-agent-test.mjs; never load the project's API keys here.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { readFileSync, mkdirSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';

export class CodexResponder extends EventEmitter {
  constructor(cwd) {
    super();
    this.cwd = cwd;
    this.pending = new Map();
    this.sequence = 0;
    this.alive = true;
    this.proc = spawn(
      'codex',
      [
        'app-server',
        '--listen',
        'stdio://',
        '--disable',
        'shell_tool',
        '--disable',
        'unified_exec',
        '--disable',
        'multi_agent',
        '--disable',
        'sleep_tool',
        '-c',
        'mcp_servers={}',
        '-c',
        'web_search="disabled"',
      ],
      {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !/(?:API_KEY|OIDC_TOKEN|ADMIN_PASSWORD|SESSION_SECRET|LOCAL_AGENT_API_TOKEN)/.test(
                key,
              ),
          ),
        ),
      },
    );
    // Never echo provider errors or credentials from the child into HTTP/logs.
    this.proc.stderr.resume();
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id != null && this.pending.has(message.id) && !message.method) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        message.error
          ? reject(
              Error(
                'Codex RPC rejected: ' +
                  message.error.code +
                  ' ' +
                  String(message.error.message).slice(0, 180),
              ),
            )
          : resolve(message.result);
      } else if (message.id != null && message.method) {
        this.send({
          id: message.id,
          error: {
            code: -32601,
            message: 'Tools and approvals are disabled in this text responder',
          },
        });
      } else if (message.method) this.emit('notification', message);
    });
    const exited = () => {
      this.alive = false;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(Error('Codex backend exited'));
      }
      this.pending.clear();
      this.emit('backendExit');
    };
    this.proc.once('error', exited);
    this.proc.once('exit', exited);
  }
  send(message) {
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  rpc(method, params, timeout = 30000) {
    if (!this.alive) return Promise.reject(Error('Codex backend unavailable'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('Codex RPC timed out'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.rpc('initialize', {
      clientInfo: {
        name: 'aoki_local_responder',
        title: 'Aoki local conversation responder',
        version: '0.1.0',
      },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
    const account = await this.rpc('account/read', { refreshToken: false });
    if (account.account?.type !== 'chatgpt')
      throw Error('This local responder requires an existing ChatGPT Codex login');
  }
  async respond(body, onDelta, signal) {
    // The one backend serves one request at a time. Ephemeral request threads
    // keep one customer's prompt out of the next customer's model context.
    const start = await this.rpc('thread/start', {
      cwd: this.cwd,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      serviceName: 'aoki-local-response-test',
      baseInstructions:
        'You are a text-only API response generator, not a coding agent. Never call tools, inspect files, browse, execute commands, or delegate. Answer only the current request. Return only the requested response, with no progress messages or code fences.',
      developerInstructions:
        typeof body.instructions === 'string'
          ? body.instructions
          : 'Answer the user concisely in Japanese.',
    });
    const threadId = start.thread.id;
    let text = '',
      finalText = '',
      turnId;
    let finish, fail;
    const complete = new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    // An abort can arrive while the turn/start RPC is still being acknowledged.
    complete.catch(() => {});
    const onEvent = ({ method, params }) => {
      if (params?.threadId !== threadId) return;
      if (method === 'item/agentMessage/delta') {
        text += params.delta;
        onDelta(params.delta);
      }
      if (method === 'item/completed' && params.item?.type === 'agentMessage')
        finalText = params.item.text;
      if (method === 'turn/completed')
        params.turn.status === 'completed'
          ? finish(finalText || text)
          : fail(Error('Codex turn did not complete'));
    };
    const onAbort = () => {
      if (turnId) this.rpc('turn/interrupt', { threadId, turnId }).catch(() => {});
      fail(Error('Local response cancelled'));
    };
    const onExit = () => fail(Error('Codex backend exited'));
    this.on('notification', onEvent);
    this.once('backendExit', onExit);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal.aborted) throw Error('Local response cancelled');
      const turn = await this.rpc('turn/start', {
        threadId,
        input: [
          {
            type: 'text',
            text: typeof body.input === 'string' ? body.input : JSON.stringify(body.input),
          },
        ],
        ...(body.text?.format?.type === 'json_schema'
          ? { outputSchema: body.text.format.schema }
          : {}),
      });
      turnId = turn.turn.id;
      const result = await complete;
      if (!result.trim()) throw Error('Empty agent response');
      if (body.text?.format?.type === 'json_schema') JSON.parse(result);
      return result;
    } finally {
      this.off('notification', onEvent);
      this.off('backendExit', onExit);
      signal.removeEventListener('abort', onAbort);
      // Ephemeral threads are not a project DB or durable prompt log.
      this.rpc('thread/unsubscribe', { threadId }).catch(() => {});
    }
  }
  close() {
    this.proc.kill('SIGTERM');
  }
}

function authorized(header, token) {
  const supplied = Buffer.from(header || '');
  const expected = Buffer.from('Bearer ' + token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createResponsesServer({ responder, token }) {
  let busy = false;
  const metrics = { completed: 0, failed: 0 };
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const error = (res, status, code) =>
    json(res, status, { error: { type: 'local_agent_error', code, message: code } });
  return createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET')
      return json(res, responder.alive === false ? 503 : 200, {
        backend: 'codex-agent',
        model: 'local-agent',
        ready: responder.alive !== false,
        busy,
        ...metrics,
      });
    if (!authorized(req.headers.authorization, token)) return error(res, 401, 'invalid_api_key');
    if (req.url === '/v1/models' && req.method === 'GET')
      return json(res, 200, {
        object: 'list',
        data: [{ id: 'local-agent', object: 'model', owned_by: 'local-codex-test' }],
      });
    if (req.url !== '/v1/responses' || req.method !== 'POST')
      return error(res, 404, 'unsupported_endpoint');
    if (req.headers.origin) return error(res, 403, 'server_to_server_only');
    let body;
    try {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 1000000) return error(res, 413, 'request_too_large');
      }
      body = JSON.parse(raw);
    } catch {
      return error(res, 400, 'invalid_json');
    }
    if (
      !body ||
      body.model !== 'local-agent' ||
      !(typeof body.input === 'string' || Array.isArray(body.input))
    )
      return error(res, 400, 'unsupported_request');
    if (body.tools?.length || body.previous_response_id || body.store === true)
      return error(res, 400, 'unsupported_tools_or_storage');
    if (busy) return error(res, 429, 'single_agent_busy');
    if (responder.alive === false) return error(res, 503, 'agent_unavailable');
    busy = true;
    const id = 'resp_local_' + randomUUID().replaceAll('-', '');
    const itemId = 'msg_local_' + randomUUID().replaceAll('-', '');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 115000);
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    let sequence = 0;
    const event = (value) => {
      if (!res.destroyed)
        res.write(
          `event: ${value.type}\ndata: ${JSON.stringify({ ...value, sequence_number: sequence++ })}\n\n`,
        );
    };
    const response = (status, text = '') => ({
      id,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status,
      model: 'local-agent',
      error: null,
      output: text
        ? [
            {
              id: itemId,
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
            },
          ]
        : [],
      output_text: text,
      usage: null,
    });
    if (body.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        'X-Local-Agent': 'codex',
      });
      event({ type: 'response.created', response: response('in_progress') });
    }
    try {
      const text = await responder.respond(
        body,
        (delta) => {
          if (body.stream)
            event({
              type: 'response.output_text.delta',
              item_id: itemId,
              output_index: 0,
              content_index: 0,
              delta,
              logprobs: [],
            });
        },
        abort.signal,
      );
      if (body.stream) {
        event({
          type: 'response.output_text.done',
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          text,
          logprobs: [],
        });
        event({ type: 'response.completed', response: response('completed', text) });
        res.end();
      } else json(res, 200, response('completed', text));
      metrics.completed++;
    } catch (failure) {
      if (failure instanceof Error && failure.message.startsWith('Codex RPC rejected:'))
        console.error(failure.message.match(/^Codex RPC rejected: -?\d+/)?.[0]);
      metrics.failed++;
      if (body.stream) {
        event({
          type: 'response.failed',
          response: {
            ...response('failed'),
            error: {
              code: 'local_agent_failed',
              message: 'The dedicated local agent could not complete this request',
            },
          },
        });
        res.end();
      } else if (!res.destroyed) error(res, 502, 'local_agent_failed');
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  });
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const token = readFileSync(process.env.LOCAL_AGENT_API_TOKEN_FILE, 'utf8').trim();
  const cwd = process.env.LOCAL_AGENT_WORKSPACE;
  if (!cwd || !/^[A-Za-z0-9_-]{32,200}$/.test(token))
    throw Error('Use the local-agent-test launcher');
  mkdirSync(cwd, { recursive: true });
  const responder = new CodexResponder(cwd);
  try {
    await responder.initialize();
  } catch (error) {
    responder.close();
    throw error;
  }
  const server = createResponsesServer({ responder, token });
  const port = Number(process.env.LOCAL_AGENT_PORT || 4010);
  server.on('error', () => {
    responder.close();
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () =>
    console.log(
      `Local agent Responses API: http://127.0.0.1:${port}/v1/responses (one backend, ChatGPT Codex login)`,
    ),
  );
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.on(sig, () => {
      server.close();
      responder.close();
      process.exit();
    });
}
