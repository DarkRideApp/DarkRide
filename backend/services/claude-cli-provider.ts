import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from 'fs';
import { join } from 'path';
import { eq, isNotNull } from 'drizzle-orm';
import { createLoggers } from '../logs';
import type { ApiKeyManager } from '../auth/api-key-manager';
import type { AppDatabase } from '../db/index';
import { users, aiConversations } from '../db/schema';
import type { AgentIdentity } from './ai-agent';

const { log, error: logError } = createLoggers('claude-cli');

// ── Types ────────────────────────────────────────────────────────────

/** Events emitted by the Claude CLI stream-json output */
export interface ClaudeInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  tools: string[];
  mcp_servers: string[];
  model: string;
}

export interface ClaudeAssistantEvent {
  type: 'assistant';
  message: {
    id: string;
    model: string;
    role: 'assistant';
    stop_reason: string;
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: Record<string, any> }
    >;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  session_id: string;
  error?: string;
}

export interface ClaudeToolResultEvent {
  type: 'tool';
  tool_use_id: string;
  name: string;
  content: string;
  session_id: string;
}

export interface ClaudeResultEvent {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  duration_ms: number;
  num_turns: number;
  result: string;
  session_id: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export type ClaudeStreamEvent =
  | ClaudeInitEvent
  | ClaudeAssistantEvent
  | ClaudeToolResultEvent
  | ClaudeResultEvent
  | { type: string; [key: string]: any };

/** Callbacks for consuming Claude CLI events */
export interface ClaudeCliCallbacks {
  /** Streamed text chunk from assistant */
  onText: (text: string) => void;
  /** Claude started a tool call (via MCP) */
  onToolStart: (toolUseId: string, toolName: string, input: Record<string, any>) => void;
  /** Tool execution completed (via MCP) */
  onToolResult: (toolUseId: string, toolName: string, result: string) => void;
  /** Token usage update */
  onUsage: (inputTokens: number, outputTokens: number) => void;
  /** Session initialized */
  onSessionInit: (sessionId: string) => void;
}

export interface ClaudeCliResult {
  sessionId: string;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  numTurns: number;
  error?: string;
}

// ── MCP Config ──────────────────────────────────────────────────────

const DATA_DIR = join(process.cwd(), 'data');

function getMcpConfigPath(): string {
  return join(DATA_DIR, 'claude-mcp-config.json');
}

/** Generate an MCP config file pointing Claude CLI at our local MCP SSE server */
export function writeMcpConfig(port: number): string {
  const configPath = getMcpConfigPath();
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  const config = {
    mcpServers: {
      darkride: {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
      },
    },
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2));
  log(`MCP config written to ${configPath} (port ${port})`);
  return configPath;
}

export interface WriteMcpConfigArgs {
  baseDir: string;
  sessionId: string;
  port: number;
  bearerToken: string;
}

/**
 * Write a per-spawn MCP config file for the subprocess. Path is unique per
 * sessionId so concurrent AI Assistant sessions don't clobber each other.
 * File is 0600, directory is 0700.
 */
export function writeMcpConfigForSpawn(args: WriteMcpConfigArgs): string {
  if (!existsSync(args.baseDir)) {
    mkdirSync(args.baseDir, { recursive: true, mode: 0o700 });
    try { chmodSync(args.baseDir, 0o700); } catch { /* best-effort on non-posix */ }
  }
  const path = join(args.baseDir, `${args.sessionId}.json`);
  const config = {
    mcpServers: {
      darkride: {
        type: 'http',
        url: `http://127.0.0.1:${args.port}/mcp`,
        headers: {
          Authorization: `Bearer ${args.bearerToken}`,
        },
      },
    },
  };
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort on non-posix */ }
  return path;
}

// ── Claude CLI Process Manager ──────────────────────────────────────

export class ClaudeCliProvider {
  private mcpConfigPath: string;
  private oauthToken: string | undefined;
  private activeProcesses = new Map<string, ChildProcess>();
  private db: AppDatabase | null;
  private apiKeyMgr: ApiKeyManager | null;
  private port: number;

  constructor(
    mcpConfigPath: string,
    oauthToken?: string,
    db?: AppDatabase,
    apiKeyMgr?: ApiKeyManager,
    port?: number,
  ) {
    this.mcpConfigPath = mcpConfigPath;
    this.oauthToken = oauthToken;
    this.db = db ?? null;
    this.apiKeyMgr = apiKeyMgr ?? null;
    this.port = port ?? 3000;
  }

  /**
   * Update the OAuth token (e.g. when provider config changes).
   *
   * If the token value differs from the previous one, clear every stored
   * `claude_session_id` in `ai_conversations`. A token rotation almost always
   * coincides with a fresh CLI auth (`claude /login`, `setup-token`, etc.),
   * which rebuilds the on-disk session store under a new identity — the
   * sessionIds we have on record no longer exist, and the next `--resume`
   * against them would fail. Clearing here ensures every conversation's next
   * turn starts a fresh CLI session and writes the new ID back.
   */
  setOauthToken(token: string | undefined): void {
    const changed = this.oauthToken !== token;
    this.oauthToken = token;
    if (changed && this.db) {
      try {
        this.db
          .update(aiConversations)
          .set({ claudeSessionId: null })
          .where(isNotNull(aiConversations.claudeSessionId))
          .run();
      } catch (err: any) {
        logError(`Failed to clear claude_session_id on token change: ${err?.message ?? err}`);
      }
    }
  }

  /**
   * Mint an ephemeral internal PAT for the given user and write a per-spawn
   * MCP config file that includes it as a Bearer token. Returns the key ID
   * (for later revocation) and the config file path.
   *
   * Exposed as `public` so unit tests can call it without spawning a subprocess.
   */
  public mintEphemeralToken(userId: number, sessionId: string): { keyId: number; configPath: string } {
    if (!this.db || !this.apiKeyMgr) {
      throw new Error('ClaudeCliProvider: db and apiKeyMgr are required to mint ephemeral tokens');
    }

    const user = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user || !user.enabled) {
      throw new Error(`ClaudeCliProvider: user ${userId} not found or disabled`);
    }

    const userScopes: string[] = Array.isArray(user.scopes)
      ? user.scopes
      : JSON.parse((user.scopes as any) || '[]');

    const { id: keyId, key } = this.apiKeyMgr.create(
      userId,
      'AI Assistant (ephemeral)',
      userScopes,
      new Date(Date.now() + 10 * 60 * 1000), // 10 min TTL
      true, // internal
    );

    const baseDir = join(DATA_DIR, 'claude-mcp-configs');
    const configPath = writeMcpConfigForSpawn({
      baseDir,
      sessionId,
      port: this.port,
      bearerToken: key,
    });

    log(`Minted ephemeral PAT keyId=${keyId} for userId=${userId} session=${sessionId}`);
    return { keyId, configPath };
  }

  /**
   * Mint an ephemeral internal PAT using scopes from an AgentIdentity directly —
   * no DB user-row lookup needed. Works for service-account identities whose scopes
   * may be narrower than the user row's full scope set.
   *
   * Exposed as `public` so unit tests can call it without spawning a subprocess.
   */
  public mintEphemeralTokenForIdentity(
    identity: AgentIdentity,
    sessionId: string,
  ): { keyId: number; configPath: string } {
    if (!this.apiKeyMgr) {
      throw new Error('ClaudeCliProvider: apiKeyMgr is required to mint ephemeral tokens');
    }

    const { id: keyId, key } = this.apiKeyMgr.create(
      identity.actorUserId,
      this.describeKeyName(identity),
      identity.effectiveScopes,
      new Date(Date.now() + 10 * 60 * 1000), // 10 min TTL
      true, // internal — bypasses wildcard validation
    );

    const configPath = writeMcpConfigForSpawn({
      baseDir: join(DATA_DIR, 'claude-mcp-configs'),
      sessionId,
      port: this.port,
      bearerToken: key,
    });

    log(`Minted ephemeral PAT keyId=${keyId} for identity=${identity.identityType} actorUserId=${identity.actorUserId} session=${sessionId}`);
    return { keyId, configPath };
  }

  private describeKeyName(id: AgentIdentity): string {
    switch (id.identityType) {
      case 'user': return 'AI Assistant (ephemeral)';
      case 'core-service': return `Service ${id.onBehalfOfService} (ephemeral)`;
      case 'plugin': return `Plugin ${id.onBehalfOfPlugin} (ephemeral)`;
      case 'plugin-acting-for-user':
        return `Plugin ${id.onBehalfOfPlugin} on behalf of user (ephemeral)`;
    }
  }

  /**
   * Revoke the ephemeral PAT and delete the per-spawn config file.
   *
   * Exposed as `public` so unit tests can call it directly.
   */
  public revokeEphemeralToken(keyId: number, userId: number, configPath: string): void {
    if (this.apiKeyMgr) {
      try {
        this.apiKeyMgr.revoke(keyId, userId);
        log(`Revoked ephemeral PAT keyId=${keyId} for userId=${userId}`);
      } catch {
        // Already revoked or not found — no-op
      }
    }
    try {
      unlinkSync(configPath);
    } catch {
      // Already gone — no-op
    }
  }

  /**
   * Send a message to Claude via the CLI subprocess.
   *
   * The Claude CLI handles the entire tool loop via MCP — we just relay events.
   * Returns when the CLI process completes (all tool turns finished).
   *
   * Auth for the per-spawn MCP config:
   *   - Pass `identity` to mint a scoped ephemeral token via mintEphemeralTokenForIdentity.
   *   - Omit `identity` to fall back to the singleton mcpConfigPath (no auth header).
   *
   * Self-heal on stale `--resume`: when an attempt with `sessionId` exits non-zero
   * having produced zero turns, the session ID we passed doesn't exist on the
   * CLI's on-disk session store (typical after `claude /login`, an `~/.claude`
   * rebuild, or a server-side claude-code upgrade that wipes session shape).
   * Retry the spawn exactly once without `--resume` so a fresh session is created
   * and the user's next message lands cleanly; the new session ID flows back
   * through the result for the caller to persist.
   */
  async sendMessage(
    prompt: string,
    callbacks: ClaudeCliCallbacks,
    options?: {
      sessionId?: string;
      model?: string;
      signal?: AbortSignal;
      maxBudgetUsd?: number;
      systemPrompt?: string;
      identity?: AgentIdentity;
    },
  ): Promise<ClaudeCliResult> {
    const first = await this._attemptSend(prompt, callbacks, options);

    const triedResume = options?.sessionId != null;
    const looksLikeStaleResume =
      triedResume
      && first.numTurns === 0
      && typeof first.error === 'string'
      && /exited with code/i.test(first.error);

    if (looksLikeStaleResume) {
      log(`Stale --resume session ${options!.sessionId} — retrying without --resume`);
      const { sessionId: _drop, ...optionsWithoutResume } = options as { sessionId?: string } & typeof options;
      return this._attemptSend(prompt, callbacks, optionsWithoutResume);
    }

    return first;
  }

  private async _attemptSend(
    prompt: string,
    callbacks: ClaudeCliCallbacks,
    options?: {
      sessionId?: string;
      model?: string;
      signal?: AbortSignal;
      maxBudgetUsd?: number;
      systemPrompt?: string;
      identity?: AgentIdentity;
    },
  ): Promise<ClaudeCliResult> {
    // spawnSessionId is declared once here so the processKey below shares the exact same string,
    // avoiding two separate Date.now() calls that could produce different values.
    const spawnSessionId = options?.sessionId || `new-${Date.now()}`;

    // Determine effective MCP config path: per-spawn (with PAT) or singleton fallback.
    let effectiveConfigPath = this.mcpConfigPath;
    let ephemeralKeyId: number | null = null;
    let ephemeralConfigPath: string | null = null;
    // Who to attribute revocation to — actorUserId from the identity.
    let ephemeralOwnerUserId: number | null = null;

    if (options?.identity != null) {
      // Identity path — scopes come from the identity object.
      try {
        const minted = this.mintEphemeralTokenForIdentity(options.identity, spawnSessionId);
        ephemeralKeyId = minted.keyId;
        ephemeralConfigPath = minted.configPath;
        ephemeralOwnerUserId = options.identity.actorUserId;
        effectiveConfigPath = ephemeralConfigPath;
      } catch (err) {
        return Promise.reject(err);
      }
    }
    // Singleton path (no identity): effectiveConfigPath stays as this.mcpConfigPath.

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--mcp-config', effectiveConfigPath,
      '--strict-mcp-config',
      '--permission-mode', 'bypassPermissions',
    ];

    if (options?.sessionId) {
      args.push('--resume', options.sessionId);
    }
    // Note: we do NOT pass --no-session-persistence here, even for new conversations.
    // Claude CLI must be allowed to persist sessions to disk so that --resume works
    // on subsequent turns. We track the session ID in our own DB for continuity.

    // Default to Sonnet (better at following tool constraints, cheaper)
    args.push('--model', options?.model || 'sonnet');

    // We previously passed `--tools ''` here to force MCP-only tool use, but
    // that flag exposes a Claude CLI `--print`-mode race: the CLI fires
    // session init (and prompts the model) before the MCP handshake has
    // settled, so the model sees `tools: []` and either says "I don't have
    // those tools" or text-leaks `<invoke>` markup. Verified end-to-end on
    // 2026-06-04 (see scripts/test-mcp-http-and-debug.sh): the MCP HTTP
    // server received initialize → initialized → tools/list, yet the init
    // event still showed mcp_servers status=pending and tools=[]. Hooks
    // delaying init didn't help (even 5s).
    //
    // Leaving built-in tools enabled gives the model something to call
    // immediately, breaking the race. Each AI flow's system prompt must now
    // explicitly require the specific MCP tools it expects (e.g. AI Review
    // must say "ALWAYS call review_apk_findings to record findings; do not
    // write to disk via the Write tool").

    if (options?.maxBudgetUsd) {
      args.push('--max-budget-usd', String(options.maxBudgetUsd));
    }

    if (options?.systemPrompt) {
      args.push('--system-prompt', options.systemPrompt);
    }

    log(`Spawning claude CLI: claude ${args.join(' ')}${this.oauthToken ? ' (with oauth token)' : ''}${ephemeralKeyId != null ? ` (ephemeral PAT keyId=${ephemeralKeyId})` : ''}`);

    const env = { ...process.env };
    if (this.oauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = this.oauthToken;
    }

    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    let sessionId = '';
    let totalUsage = { inputTokens: 0, outputTokens: 0 };
    let costUsd = 0;
    let numTurns = 0;
    let resultError: string | undefined;

    // processKey shares spawnSessionId — no second Date.now() call.
    const processKey = spawnSessionId;
    this.activeProcesses.set(processKey, child);

    // Single-path revocation: 'close' always fires last for any exit path, so we
    // revoke only there. 'error' simply rejects the promise without revoking.
    // revokeOnce guards against double-calls (e.g. aborted signal path).
    let tokenRevoked = false;
    const revokeOnce = () => {
      if (tokenRevoked) return;
      tokenRevoked = true;
      if (ephemeralKeyId !== null && ephemeralOwnerUserId !== null && ephemeralConfigPath !== null) {
        this.revokeEphemeralToken(ephemeralKeyId, ephemeralOwnerUserId, ephemeralConfigPath);
      }
    };

    // Handle abort signal
    let abortCleanup: (() => void) | undefined;
    if (options?.signal) {
      const onAbort = () => {
        log(`Aborting claude CLI process (session: ${sessionId || processKey})`);
        child.kill('SIGTERM');
        // Give it a moment to clean up, then force kill
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 3000);
      };

      if (options.signal.aborted) {
        child.kill('SIGTERM');
        this.activeProcesses.delete(processKey);
        revokeOnce();
        return Promise.resolve({
          sessionId: '',
          usage: totalUsage,
          costUsd: 0,
          numTurns: 0,
          error: 'Aborted',
        });
      }

      options.signal.addEventListener('abort', onAbort, { once: true });
      abortCleanup = () => options.signal!.removeEventListener('abort', onAbort);
    }

    // Write prompt to stdin and close
    child.stdin!.write(prompt);
    child.stdin!.end();

    // Collect stderr for error reporting
    let stderrChunks: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrChunks.push(text);
      // Only log non-empty stderr
      if (text.trim()) {
        logError(`claude stderr: ${text.trim()}`);
      }
    });

    // Parse streaming JSON from stdout
    return new Promise<ClaudeCliResult>((resolve, reject) => {
      let settled = false;
      let buffer = '';

      child.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop()!; // Keep incomplete last line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let event: ClaudeStreamEvent;
          try {
            event = JSON.parse(trimmed);
          } catch {
            logError(`Failed to parse claude stream-json line: ${trimmed.slice(0, 200)}`);
            continue;
          }

          this.handleStreamEvent(event, callbacks, (sid) => {
            sessionId = sid;
          }, totalUsage, (cost, turns, error) => {
            costUsd = cost;
            numTurns = turns;
            if (error) resultError = error;
          });
        }
      });

      child.on('close', (code) => {
        abortCleanup?.();

        // Process any remaining buffer
        if (buffer.trim()) {
          try {
            const event: ClaudeStreamEvent = JSON.parse(buffer.trim());
            this.handleStreamEvent(event, callbacks, (sid) => {
              sessionId = sid;
            }, totalUsage, (cost, turns, error) => {
              costUsd = cost;
              numTurns = turns;
              if (error) resultError = error;
            });
          } catch {
            // Ignore incomplete final line
          }
        }

        this.activeProcesses.delete(processKey);

        // Single revocation point — 'error' handler does NOT revoke, only rejects.
        revokeOnce();

        if (code !== 0 && code !== null) {
          const stderr = stderrChunks.join('').trim();
          logError(`claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`);
          resultError = resultError || (stderr
            ? `Claude CLI error: ${stderr.slice(0, 200)}`
            : `Claude CLI exited with code ${code}`);
        }

        // Only resolve if 'error' hasn't already settled the promise
        if (!settled) {
          settled = true;
          resolve({
            sessionId,
            usage: totalUsage,
            costUsd,
            numTurns,
            error: resultError,
          });
        }
      });

      child.on('error', (err) => {
        // Don't revoke here — 'close' fires immediately after 'error' and handles it.
        this.activeProcesses.delete(processKey);
        logError(`claude CLI spawn error: ${err.message}`);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  /** Process a single stream-json event from the Claude CLI */
  private handleStreamEvent(
    event: ClaudeStreamEvent,
    callbacks: ClaudeCliCallbacks,
    onSessionId: (id: string) => void,
    totalUsage: { inputTokens: number; outputTokens: number },
    onResult: (costUsd: number, numTurns: number, error?: string) => void,
  ): void {
    switch (event.type) {
      case 'system': {
        if (event.subtype === 'init') {
          const init = event as ClaudeInitEvent;
          onSessionId(init.session_id);
          callbacks.onSessionInit(init.session_id);
          log(`Claude CLI session: ${init.session_id}, model: ${init.model}, MCP servers: ${init.mcp_servers?.join(', ') || 'none'}`);
        }
        break;
      }

      case 'assistant': {
        const assistantEvent = event as ClaudeAssistantEvent;
        const msg = assistantEvent.message;

        if (assistantEvent.error) {
          logError(`Claude CLI error in assistant event: ${assistantEvent.error}`);
        }

        // Process content blocks
        if (msg?.content) {
          for (const block of msg.content) {
            if (block.type === 'text') {
              callbacks.onText(block.text);
            } else if (block.type === 'tool_use') {
              callbacks.onToolStart(block.id, block.name, block.input);
            }
          }
        }

        // Track usage from individual assistant messages
        if (msg?.usage) {
          const inputDelta = msg.usage.input_tokens || 0;
          const outputDelta = msg.usage.output_tokens || 0;
          if (inputDelta > 0 || outputDelta > 0) {
            totalUsage.inputTokens += inputDelta;
            totalUsage.outputTokens += outputDelta;
            callbacks.onUsage(totalUsage.inputTokens, totalUsage.outputTokens);
          }
        }
        break;
      }

      case 'tool': {
        // Legacy SSE transport format (kept for compatibility)
        const toolEvent = event as ClaudeToolResultEvent;
        const content = typeof toolEvent.content === 'string'
          ? toolEvent.content
          : JSON.stringify(toolEvent.content);
        callbacks.onToolResult(
          toolEvent.tool_use_id,
          toolEvent.name || 'unknown',
          content,
        );
        break;
      }

      case 'user': {
        // HTTP Streamable transport: tool results come back as user events
        const userMsg = (event as any).message;
        if (Array.isArray(userMsg?.content)) {
          for (const block of userMsg.content) {
            if (block.type === 'tool_result') {
              const content = Array.isArray(block.content)
                ? block.content.map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
                : typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
              callbacks.onToolResult(block.tool_use_id, '', content);
            }
          }
        }
        break;
      }

      case 'result': {
        const result = event as ClaudeResultEvent;
        onSessionId(result.session_id);

        // Update final usage from the result event
        if (result.usage) {
          totalUsage.inputTokens = result.usage.input_tokens || 0;
          totalUsage.outputTokens = result.usage.output_tokens || 0;
          callbacks.onUsage(totalUsage.inputTokens, totalUsage.outputTokens);
        }

        onResult(
          result.total_cost_usd || 0,
          result.num_turns || 0,
          result.is_error ? result.result : undefined,
        );

        log(`Claude CLI complete: ${result.num_turns} turns, $${result.total_cost_usd?.toFixed(4) || '0'}, ${result.duration_ms}ms`);
        break;
      }
    }
  }

  /**
   * Self-test that the CLI can actually DRIVE a tool with the given auth, not
   * just authenticate. We ask the model to call a built-in tool (Bash); a
   * working Claude Code session will make a real `tool_use` block, a broken
   * one will text-leak `<invoke>` markup as content.
   *
   * Previously this spun up a throwaway stdio MCP server and asked the model
   * to call a `ping` tool there — but verified on 2026-06-04 that the CLI's
   * `--print` mode fires session init (and prompts the model) before MCP
   * handshakes settle, so the model saw `tools: []` and the test failed for
   * environmental reasons that had nothing to do with the token. Built-ins
   * are registered synchronously at init, so they sidestep that race
   * entirely and still reveal a text-leaking token.
   */
  static async testToolUse(
    oauthToken: string | undefined,
    model: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const env = oauthToken
      ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: oauthToken }
      : { ...process.env };
    const args = [
      '--print', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--model', model || 'sonnet',
    ];
    return await new Promise((resolve) => {
      const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], env });
      let out = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ ok: false, reason: 'Timed out waiting for the Claude CLI tool self-test' });
      }, 60000);
      child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
      child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ ok: false, reason: 'Claude CLI not found or not executable' });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(evaluateToolSelfTest(out, code, stderr));
      });
      child.stdin?.write(
        'Use your Bash tool to run the command `echo darkride-selftest`, then reply "done".',
      );
      child.stdin?.end();
    });
  }

  /** Kill all active Claude CLI processes (for graceful shutdown) */
  killAll(): void {
    for (const [key, child] of this.activeProcesses) {
      log(`Killing claude CLI process: ${key}`);
      child.kill('SIGTERM');
    }
    this.activeProcesses.clear();
  }

  /** Check if the Claude CLI is available */
  static async isAvailable(oauthToken?: string): Promise<boolean> {
    return new Promise((resolve) => {
      const env = oauthToken
        ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: oauthToken }
        : undefined;
      const child = spawn('claude', ['--version'], { stdio: 'pipe', env });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  }

  /**
   * Return the installed Claude CLI semver (e.g. "2.1.158"), or null if the
   * binary is missing or doesn't report a version. Parses `claude --version`
   * output of the form "2.1.158 (Claude Code)".
   */
  static async getVersion(oauthToken?: string): Promise<string | null> {
    return new Promise((resolve) => {
      const env = oauthToken
        ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: oauthToken }
        : undefined;
      const child = spawn('claude', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], env });
      let out = '';
      let settled = false;
      const done = (v: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      // Bound the wait — this sits on the Settings status path and before every
      // claude-cli model test, so a hung `claude --version` must not hang the request.
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(null); }, 10000);
      child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
      child.on('close', (code) => {
        if (code !== 0) { done(null); return; }
        const m = out.match(/(\d+\.\d+\.\d+)/);
        done(m ? m[1] : null);
      });
      child.on('error', () => done(null));
    });
  }
}

// Same markup detection as ClaudeCliAgent: tool-call XML in the assistant's
// *text* means the model couldn't really call tools.
const TOOL_CALL_LEAK_RE = /<\/?(?:antml:)?(?:invoke|function_calls)\b/i;

/** Decide the result of a tool self-test from the CLI's stream-json output. */
export function evaluateToolSelfTest(
  out: string,
  code: number | null,
  stderr: string,
): { ok: boolean; reason?: string } {
  let realToolCall = false;
  let text = '';
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e: any;
    try { e = JSON.parse(t); } catch { continue; }
    if (e.type === 'assistant' && e.message?.content) {
      for (const b of e.message.content) {
        if (b.type === 'tool_use') realToolCall = true;
        else if (b.type === 'text') text += b.text;
      }
    }
  }
  if (realToolCall) return { ok: true };
  if (TOOL_CALL_LEAK_RE.test(text)) {
    return {
      ok: false,
      reason: 'Claude authenticated but emitted tool calls as TEXT instead of running them — '
        + 'the configured token is not a working Claude Code session. Replace it (claude setup-token) '
        + 'or remove it to use the CLI login.',
    };
  }
  if (code !== 0 && code !== null) {
    return { ok: false, reason: `Claude CLI exited with code ${code}${stderr ? `: ${stderr.slice(0, 150)}` : ''}` };
  }
  return { ok: false, reason: 'Claude ran but called no tool during the self-test — tool access could not be verified.' };
}
