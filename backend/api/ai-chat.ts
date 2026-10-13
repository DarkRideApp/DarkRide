import { eq, and, or, isNull, desc, gte, lte, sql, type SQL } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { aiConversations } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { ClaudeCliProvider } from '../services/claude-cli-provider';

const LIST_DEFAULT_LIMIT = 30;
const LIST_MAX_LIMIT = 100;

/** Conversations the user owns, plus ones saved before ownership existed. */
function visibleTo(userId: number): SQL {
  return or(isNull(aiConversations.userId), eq(aiConversations.userId, userId))!;
}

function parseId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

/** Integer query parameter clamped to [min, max]; anything unparsable or below `min` gives `fallback`. */
function parseBounded(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

const ms = (d: Date | number): number => (d instanceof Date ? d.getTime() : d);

type ConversationRow = typeof aiConversations.$inferSelect;
type SummaryRow = Pick<ConversationRow, 'id' | 'title' | 'pageContext' | 'contextId' | 'originPath' | 'unfinished' | 'createdAt' | 'updatedAt'>;

function toSummary(row: SummaryRow) {
  return {
    id: row.id,
    title: row.title,
    pageContext: row.pageContext,
    contextId: row.contextId,
    originPath: row.originPath,
    unfinished: row.unfinished,
    createdAt: ms(row.createdAt),
    updatedAt: ms(row.updatedAt),
  };
}

function toConversation(row: ConversationRow) {
  return { ...toSummary(row), messages: JSON.parse(row.messages) };
}

export function registerAiChatApiEndpoints(db: AppDatabase, getClaudeCliProvider?: () => ClaudeCliProvider | null): void {
  // GET /v1/ai/claude-cli/status — claude-cli availability + installed CLI version.
  // The version matters: an outdated CLI can fail to drive tool use for newer
  // models (tool calls leak as text), which the UI surfaces as a warning.
  registerEndpoint('GET', '/v1/ai/claude-cli/status', async (_req, res) => {
    const provider = getClaudeCliProvider?.();
    const version = provider != null ? await ClaudeCliProvider.getVersion() : null;
    res.json({
      success: true,
      data: {
        available: provider != null,
        version,
      },
    });
  });
  // GET /v1/ai/conversations/latest?pageContext=X&contextId=Y
  registerEndpoint('GET', '/v1/ai/conversations/latest', (req, res) => {
    const userId = req.authUser?.userId;
    if (userId == null) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    const pageContext = req.query.pageContext as string;
    const contextId = req.query.contextId as string ?? '';

    if (!pageContext) {
      res.status(400).json({ success: false, error: 'pageContext is required' });
      return;
    }

    const row = db
      .select()
      .from(aiConversations)
      .where(
        and(
          eq(aiConversations.pageContext, pageContext),
          eq(aiConversations.contextId, contextId),
          visibleTo(userId),
        ),
      )
      .orderBy(desc(aiConversations.updatedAt))
      .limit(1)
      .all()[0];

    res.json({ success: true, data: row ? toConversation(row) : null });
  }, { requires: ['core.ai:chat'] });

  // GET /v1/ai/conversations?limit=&offset=&q=&pageContext=&contextId= (history list, newest activity first)
  registerEndpoint('GET', '/v1/ai/conversations', (req, res) => {
    const userId = req.authUser?.userId;
    if (userId == null) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    const limit = parseBounded(req.query.limit, LIST_DEFAULT_LIMIT, 1, LIST_MAX_LIMIT);
    const offset = parseBounded(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const conditions: SQL[] = [visibleTo(userId), eq(aiConversations.automated, false)];
    if (typeof req.query.pageContext === 'string' && req.query.pageContext) {
      conditions.push(eq(aiConversations.pageContext, req.query.pageContext));
    }
    if (typeof req.query.contextId === 'string') {
      conditions.push(eq(aiConversations.contextId, req.query.contextId));
    }
    if (q) {
      const pattern = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      conditions.push(sql`(${aiConversations.title} LIKE ${pattern} ESCAPE '\\' OR ${aiConversations.messages} LIKE ${pattern} ESCAPE '\\')`);
    }

    // One extra row tells us whether another page exists.
    const rows = db
      .select({
        id: aiConversations.id,
        title: aiConversations.title,
        pageContext: aiConversations.pageContext,
        contextId: aiConversations.contextId,
        originPath: aiConversations.originPath,
        unfinished: aiConversations.unfinished,
        createdAt: aiConversations.createdAt,
        updatedAt: aiConversations.updatedAt,
      })
      .from(aiConversations)
      .where(and(...conditions))
      .orderBy(desc(aiConversations.updatedAt), desc(aiConversations.id))
      .limit(limit + 1)
      .offset(offset)
      .all();

    res.json({
      success: true,
      data: {
        conversations: rows.slice(0, limit).map(toSummary),
        hasMore: rows.length > limit,
      },
    });
  }, { requires: ['core.ai:chat'] });

  // GET /v1/ai/conversations/:id
  registerEndpoint('GET', '/v1/ai/conversations/:id', (req, res) => {
    const userId = req.authUser?.userId;
    if (userId == null) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ success: false, error: 'Invalid conversation id' });
      return;
    }
    const row = db
      .select()
      .from(aiConversations)
      .where(and(eq(aiConversations.id, id), visibleTo(userId)))
      .get();
    if (!row) {
      res.status(404).json({ success: false, error: 'Conversation not found' });
      return;
    }
    res.json({ success: true, data: toConversation(row) });
  }, { requires: ['core.ai:chat'] });

  // DELETE /v1/ai/conversations/:id
  registerEndpoint('DELETE', '/v1/ai/conversations/:id', (req, res) => {
    const userId = req.authUser?.userId;
    if (userId == null) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ success: false, error: 'Invalid conversation id' });
      return;
    }
    const { changes } = db
      .delete(aiConversations)
      .where(and(eq(aiConversations.id, id), visibleTo(userId)))
      .run();
    if (changes === 0) {
      res.status(404).json({ success: false, error: 'Conversation not found' });
      return;
    }
    res.json({ success: true });
  }, { requires: ['core.ai:chat'] });

  // GET /v1/ai/usage?pageContext=X&from=timestamp&to=timestamp (the caller's conversations plus unowned ones)
  registerEndpoint('GET', '/v1/ai/usage', (req, res) => {
    const userId = req.authUser?.userId;
    if (userId == null) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    const filterContext = req.query.pageContext as string | undefined;
    const fromTs = req.query.from ? Number(req.query.from) : undefined;
    const toTs = req.query.to ? Number(req.query.to) : undefined;

    // Build filter conditions
    const conditions: SQL[] = [visibleTo(userId)];
    if (filterContext) {
      conditions.push(eq(aiConversations.pageContext, filterContext));
    }
    if (fromTs) {
      conditions.push(gte(aiConversations.createdAt, new Date(fromTs)));
    }
    if (toTs) {
      conditions.push(lte(aiConversations.createdAt, new Date(toTs)));
    }

    const where = and(...conditions);

    // Aggregate totals
    const totals = db
      .select({
        totalInputTokens: sql<number>`coalesce(sum(${aiConversations.inputTokens}), 0)`,
        totalOutputTokens: sql<number>`coalesce(sum(${aiConversations.outputTokens}), 0)`,
        conversationCount: sql<number>`count(*)`,
      })
      .from(aiConversations)
      .where(where)
      .all()[0];

    // Per-context breakdown
    const byContext = db
      .select({
        pageContext: aiConversations.pageContext,
        inputTokens: sql<number>`coalesce(sum(${aiConversations.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${aiConversations.outputTokens}), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(aiConversations)
      .where(where)
      .groupBy(aiConversations.pageContext)
      .all();

    // Recent conversations sorted by most expensive (input + output tokens)
    const recentConversations = db
      .select({
        id: aiConversations.id,
        pageContext: aiConversations.pageContext,
        contextId: aiConversations.contextId,
        title: aiConversations.title,
        inputTokens: aiConversations.inputTokens,
        outputTokens: aiConversations.outputTokens,
        createdAt: aiConversations.createdAt,
      })
      .from(aiConversations)
      .where(where)
      .orderBy(sql`coalesce(${aiConversations.inputTokens}, 0) + coalesce(${aiConversations.outputTokens}, 0) desc`)
      .limit(50)
      .all()
      .map((row) => ({
        ...row,
        createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : row.createdAt,
      }));

    res.json({
      success: true,
      data: {
        totalInputTokens: totals.totalInputTokens,
        totalOutputTokens: totals.totalOutputTokens,
        conversationCount: totals.conversationCount,
        byContext,
        conversations: recentConversations,
      },
    });
  }, { requires: ['core.ai:chat'] });
}
