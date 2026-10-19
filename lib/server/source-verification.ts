import report from '../../docs/research/source-priority-live-2026-10-18.json';
import customerReport from '../../docs/research/customer-simulation-live-2026-10-18.json';
import salesReport from '../../docs/research/sales-conversations-live-2026-10-18.json';
import astraReport from '../../docs/research/sales-conversations-astra-live-2026-10-18.json';
import stagedReport from '../../docs/research/staged-sales-live-2026-10-18.json';
import naturalStagedReport from '../../docs/research/staged-natural-live-2026-10-18.json';
import type { Conversation } from '../contracts';
import type {
  AdminConversation,
  AdminConversationDetail,
  SourceVerificationReport,
} from '../source-verification';

// A dated, staff-only record of real API conversations. Serve through the authenticated API.
export function sourceVerificationReport(): SourceVerificationReport {
  const original = report as unknown as SourceVerificationReport;
  return { ...original, scenarios: verificationReports().flatMap((r) => r.scenarios) };
}

function verificationReports(): SourceVerificationReport[] {
  return [
    report,
    customerReport,
    salesReport,
    astraReport,
    stagedReport,
    naturalStagedReport,
  ] as unknown as SourceVerificationReport[];
}

// Present archived API runs in the same staff history as customer chats. Keep the
// original record intact and avoid copying test fixtures into the customer database.
export function withVerificationConversations(conversations: Conversation[]): AdminConversation[] {
  const archived: AdminConversation[] = verificationReports().flatMap((verification) =>
    verification.scenarios.map((scenario) => ({
      id: scenario.conversationId,
      title: scenario.question,
      status: 'closed',
      createdAt: scenario.startedAt,
      updatedAt: scenario.completedAt,
      verification: {
        id: scenario.id,
        responseModel: verification.responseModel,
        preferredSiteCount: verification.initialPreferredDomains.length,
        ...(scenario.simulation
          ? { kind: 'customer_simulation' as const, turnCount: scenario.simulation.turnCount }
          : {}),
      },
    })),
  );
  const records = new Map<string, AdminConversation>(conversations.map((c) => [c.id, c]));
  for (const conversation of archived) {
    const current = records.get(conversation.id);
    records.set(
      conversation.id,
      current ? { ...current, verification: conversation.verification } : conversation,
    );
  }
  return [...records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function verificationConversation(id: string): AdminConversationDetail | undefined {
  const selected = sourceVerificationReport().scenarios.find((s) => s.conversationId === id);
  if (!selected) return;
  return {
    conversation: withVerificationConversations([]).find((c) => c.id === id)!,
    messages: selected.messages || [
      {
        id: `${selected.id}-question`,
        role: 'user',
        content: selected.question,
        createdAt: selected.startedAt,
      },
      {
        id: selected.answerId,
        role: 'assistant',
        content: selected.response,
        createdAt: selected.completedAt,
        responseProvider: selected.responseProvider,
      },
    ],
    research: selected.notes,
    answers: selected.answers || [
      {
        id: selected.answerId,
        conversationId: selected.conversationId,
        content: selected.response,
        createdAt: selected.completedAt,
        incomplete: false,
        responseProvider: selected.responseProvider || null,
        route: 'sourcing',
        processing: null,
        linkage: 'recorded',
        calls: selected.aiCalls.items,
        sourceTrace: selected.sourceTrace,
      },
    ],
    verification: selected,
  };
}
