import { eq, and, desc, gte, lte, sql } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { aiConversations } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { ClaudeCliProvider } from '../services/claude-cli-provider';

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
        ),
      )
      .orderBy(desc(aiConversations.updatedAt))
      .limit(1)
      .all()[0];

    if (!row) {
      res.json({ success: true, data: null });
      return;
    }

    res.json({
      success: true,
      data: {
        id: row.id,
        pageContext: row.pageContext,
        contextId: row.contextId,
        title: row.title,
        messages: JSON.parse(row.messages),
        createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : row.createdAt,
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : row.updatedAt,
      },
    });
  });

  // GET /v1/ai/usage?pageContext=X&from=timestamp&to=timestamp
  registerEndpoint('GET', '/v1/ai/usage', (req, res) => {
    const filterContext = req.query.pageContext as string | undefined;
    const fromTs = req.query.from ? Number(req.query.from) : undefined;
    const toTs = req.query.to ? Number(req.query.to) : undefined;

    // Build filter conditions
    const conditions = [];
    if (filterContext) {
      conditions.push(eq(aiConversations.pageContext, filterContext));
    }
    if (fromTs) {
      conditions.push(gte(aiConversations.createdAt, new Date(fromTs)));
    }
    if (toTs) {
      conditions.push(lte(aiConversations.createdAt, new Date(toTs)));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

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
  });
}
