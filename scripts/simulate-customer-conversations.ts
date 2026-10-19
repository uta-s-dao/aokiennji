import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { AppSettings, StoredChatMessage } from '../lib/contracts';
import type {
  SourceVerificationReport,
  SourceVerificationScenario,
} from '../lib/source-verification';

// A question-only agent supplies the next round after seeing public replies.
// This runner never writes that agent's private facts into the assistant context.
const [command, directory, roundArgument] = process.argv.slice(2);
const root = resolve(directory || '.data/verification/customer-simulation-2026-10-18');
if (!root.startsWith(resolve('.data/verification') + sep))
  throw Error('Use a verification directory');
if (!process.env.OPENAI_API_KEY || process.env.LOCAL_AGENT_API_URL)
  throw Error('A configured real OpenAI API is required');
const sandbox = join(root, 'sandbox');
const agentDirectory = join(root, 'customer-agent');
mkdirSync(agentDirectory, { recursive: true });
const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8'));
const write = (path: string, data: unknown) =>
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
const tables = [
  'settings',
  'sources',
  'products',
  'documents',
  'supplier_knowledge',
  'conversations',
  'messages',
  'research_notes',
  'ai_calls',
  'quotes',
  'orders',
];
function snapshot(database: Database.Database) {
  return Object.fromEntries(
    tables.map((table) => {
      const rows = database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      return [
        table,
        {
          count: rows.length,
          hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        },
      ];
    }),
  );
}
interface Profile {
  id: string;
  label: string;
  initialQuestion: string;
  persona: string;
  privateFacts: Record<string, unknown>;
  customerGoal: string;
}
interface Session {
  id: string;
  startedAt: string;
  conversationId?: string;
  completedRounds: number[];
  errors: { round: number; message: string }[];
}
interface State {
  originalFile: string;
  before: ReturnType<typeof snapshot>;
  testedAt: string;
  settings: AppSettings;
  preferredDomains: string[];
  demoMode: boolean;
  sessions: Session[];
}
const statePath = join(root, 'state.json');

async function main() {
  if (command === 'init') {
    if (existsSync(statePath) || existsSync(join(sandbox, 'aokienji.sqlite')))
      throw Error('This run already exists; use round/export to resume');
    mkdirSync(sandbox, { recursive: true });
    const originalFile = resolve(process.env.DATA_DIR || '.data', 'aokienji.sqlite');
    const original = new Database(originalFile, { readonly: true });
    const before = snapshot(original);
    await original.backup(join(sandbox, 'aokienji.sqlite'));
    original.close();
    const database = new Database(join(sandbox, 'aokienji.sqlite'));
    const settings: AppSettings = JSON.parse(
      (database.prepare('SELECT json FROM settings WHERE id=1').get() as { json: string }).json,
    );
    if (settings.responseProvider !== 'openai')
      throw Error('Current response provider must be OpenAI');
    // Preserve the actual search/classification/model settings. No fixture pages.
    settings.flags = { ...settings.flags, orders: false, autoOrder: false, autoQuote: false };
    database.prepare('UPDATE settings SET json=? WHERE id=1').run(JSON.stringify(settings));
    database.exec(
      'DELETE FROM messages; DELETE FROM conversations; DELETE FROM research_notes; DELETE FROM ai_calls; DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM rate_limits;',
    );
    database.close();
    process.env.DATA_DIR = sandbox;
    const { createSourceTrace, preferredDomains } = await import('../lib/server/preferred-sources');
    const state: State = {
      originalFile,
      before,
      settings,
      testedAt: new Date().toISOString(),
      preferredDomains: preferredDomains(createSourceTrace()),
      demoMode: process.env.DEMO_MODE !== 'false',
      sessions: [],
    };
    write(statePath, state);
    console.log(
      JSON.stringify({
        phase: 'ready',
        preferredDomains: state.preferredDomains.length,
        responseModel: settings.responseModel,
        classification: settings.decisionProvider,
        demoMode: state.demoMode,
      }),
    );
    return;
  }

  const state = read<State>(statePath);
  process.env.DATA_DIR = sandbox;
  process.env.ALLOW_LIVE_ORDERS = 'false';
  const { answerChat, currentMessages } = await import('../lib/server/chat');
  const { conversationMessages } = await import('../lib/server/business');
  const { aiAnswerReport } = await import('../lib/server/ai-answer-history');
  const { researchNotes } = await import('../lib/server/research');
  const { aiUsageReport } = await import('../lib/server/ai-usage');
  const { db, resetDbForTests } = await import('../lib/server/db');
  const profiles = read<Profile[]>(join(agentDirectory, 'profiles.json'));
  if (profiles.length !== 10 || new Set(profiles.map((p) => p.id)).size !== 10)
    throw Error('Ten unique customer profiles required');
  try {
    if (command === 'round') {
      const round = Number(roundArgument);
      if (!Number.isInteger(round) || round < 1 || round > 10) throw Error('Invalid round');
      const roundName = String(round).padStart(2, '0');
      const questions = read<{ id: string; message: string; intent: string }[]>(
        join(agentDirectory, `round-${roundName}.json`),
      );
      if (
        questions.length !== 10 ||
        new Set(questions.map((q) => q.id)).size !== 10 ||
        questions.some(
          (q) =>
            !profiles.some((p) => p.id === q.id) || !q.message.trim() || q.message.length > 2000,
        )
      )
        throw Error('Round must contain one valid question per customer');
      let index = 0;
      await Promise.all(
        Array.from({ length: 3 }, async () => {
          while (index < questions.length) {
            const question = questions[index++];
            let session = state.sessions.find((s) => s.id === question.id);
            if (!session) {
              if (round !== 1) throw Error('Initial round missing');
              session = {
                id: question.id,
                startedAt: new Date().toISOString(),
                completedRounds: [],
                errors: [],
              };
              state.sessions.push(session);
            }
            if (session.completedRounds.includes(round)) continue;
            if (round > 1 && !session.completedRounds.includes(round - 1))
              throw Error('Previous round missing');
            try {
              const deferred: (() => Promise<void>)[] = [];
              const reply = await answerChat(
                question.message,
                `customer-simulation-${question.id}`,
                session.conversationId,
                { defer: (work) => deferred.push(work) },
              );
              session.conversationId = reply.conversationId;
              for (const work of deferred) await work();
              console.log(
                JSON.stringify({
                  round,
                  customer: question.id,
                  provider: reply.message.responseProvider,
                  route: reply.message.route,
                  sourcing: reply.message.sourcing?.status,
                }),
              );
            } catch (error) {
              const row = db()
                .prepare(
                  'SELECT id FROM conversations WHERE owner_id=? ORDER BY rowid DESC LIMIT 1',
                )
                .get(`customer-simulation-${question.id}`) as { id: string } | undefined;
              session.conversationId ||= row?.id;
              const message = error instanceof Error ? error.message : 'Unknown chat failure';
              session.errors.push({ round, message });
              console.log(JSON.stringify({ round, customer: question.id, error: message }));
            }
            session.completedRounds.push(round);
            write(statePath, state);
            checkpoint();
          }
        }),
      );
      const publicRounds = profiles.map((profile) => {
        const session = state.sessions.find((s) => s.id === profile.id)!;
        return {
          id: profile.id,
          history: session.conversationId
            ? conversationMessages(session.conversationId).map((m) => ({
                role: m.role,
                content: m.content,
                suggestions: m.suggestions,
                handoff: m.handoff,
              }))
            : [],
          errors: session.errors,
        };
      });
      write(join(agentDirectory, `public-round-${roundName}.json`), publicRounds);
      checkpoint();
      console.log(
        JSON.stringify({ phase: 'round-complete', round, sessions: state.sessions.length }),
      );
    } else if (command === 'export') {
      const report = checkpoint();
      if (
        report.scenarios.length !== 10 ||
        state.sessions.some((s) => s.completedRounds.length < 5)
      )
        throw Error('Complete at least five rounds before publishing');
      if (report.scenarios.some((s) => !s.simulation?.review))
        throw Error('Customer-agent review required');
      const serialized = JSON.stringify(report);
      const sensitive = Object.entries(process.env).filter(
        ([name, value]) =>
          /(?:API_KEY|SESSION_SECRET|PASSWORD)/.test(name) && value && value.length >= 12,
      );
      if (sensitive.some(([, value]) => serialized.includes(value!)))
        throw Error('Credential found in report; publication stopped');
      write('docs/research/customer-simulation-live-2026-10-18.json', report);
      const calls = report.scenarios.flatMap((s) => s.aiCalls.items);
      const answers = report.scenarios.flatMap((s) => s.answers || []);
      const summary = {
        checkedAt: new Date().toISOString(),
        conversations: report.scenarios.length,
        customerTurns: report.scenarios.reduce((n, s) => n + (s.simulation?.turnCount || 0), 0),
        replies: answers.length,
        responseProviders: Object.fromEntries(
          ['openai', 'local', 'gemini'].map((p) => [
            p,
            answers.filter((a) => a.responseProvider === p).length,
          ]),
        ),
        apiCalls: calls.length,
        apiOutcomes: Object.fromEntries(
          [...new Set(calls.map((c) => c.outcome))].map((o) => [
            o,
            calls.filter((c) => c.outcome === o).length,
          ]),
        ),
        apiErrors: calls
          .filter((c) => c.outcome !== 'accepted')
          .map((c) => ({
            provider: c.provider,
            purpose: c.purpose,
            errorCode: c.errorCode,
            httpStatus: c.httpStatus,
            conversationId: c.context.conversationId,
            turnId: c.context.turnId,
          })),
        originalUnchanged: report.originalUnchanged,
        credentialLeak: false,
        configuration: report.settings,
        scenarios: report.scenarios.map((s) => ({
          id: s.id,
          label: s.simulation!.label,
          conversationId: s.conversationId,
          turns: s.simulation!.turnCount,
          checks: s.checks,
          review: s.simulation!.review,
          technicalFindings: s.simulation!.technicalFindings,
          sourcingModels: s.messages?.filter((m) => m.sourcing).map((m) => m.sourcing!.model),
          stages: [
            ...new Set(s.answers!.flatMap((a) => a.sourceTrace?.stages.map((t) => t.scope) || [])),
          ],
          sourceOrigins: [
            ...new Set(
              s.answers!.flatMap((a) => a.sourceTrace?.observations.map((o) => o.origin) || []),
            ),
          ],
          procurementCandidates: s.procurementAssessment.length,
          openaiReplies: s.answers!.filter((a) => a.responseProvider === 'openai').length,
          localResponseReasons: s
            .answers!.filter((a) => a.responseProvider === 'local')
            .map((a) => a.processing?.responseReason),
        })),
      };
      write(join(root, 'summary.json'), summary);
      write('docs/research/customer-simulation-validation-2026-10-18.json', summary);
      console.log(
        JSON.stringify({
          phase: 'exported',
          conversations: report.scenarios.length,
          answers: report.scenarios.reduce((n, s) => n + (s.answers?.length || 0), 0),
          originalUnchanged: report.originalUnchanged,
        }),
      );
    } else throw Error('Use init, round, or export');

    function checkpoint() {
      const scenarios: SourceVerificationScenario[] = profiles.flatMap((profile) => {
        const session = state.sessions.find((s) => s.id === profile.id);
        if (!session?.conversationId) return [];
        const messages = conversationMessages(session.conversationId) as StoredChatMessage[];
        const answers = aiAnswerReport({
          conversationId: session.conversationId,
          limit: 500,
        }).items.toReversed();
        const last = answers.at(-1);
        if (!last?.sourceTrace) return [];
        const notes = researchNotes(session.conversationId);
        const api = aiUsageReport({ conversationId: session.conversationId, limit: 500 });
        const traces = answers.flatMap((a) => (a.sourceTrace ? [a.sourceTrace] : []));
        const reviewPath = join(agentDirectory, 'review.json');
        const reviews = existsSync(reviewPath)
          ? read<
              {
                id: string;
                verdict: 'pass' | 'needs_review' | 'fail';
                summary: string;
                findings: { turn: number; severity: string; detail: string }[];
              }[]
            >(reviewPath)
          : [];
        const review = reviews.find((r) => r.id === profile.id);
        const technicalPath = join(root, 'technical-review.json');
        const technical = existsSync(technicalPath)
          ? read<
              {
                id: string;
                findings: NonNullable<
                  NonNullable<SourceVerificationScenario['simulation']>['technicalFindings']
                >;
              }[]
            >(technicalPath).find((r) => r.id === profile.id)?.findings
          : undefined;
        return [
          {
            id: profile.id,
            question: profile.initialQuestion,
            response: last.content,
            responseProvider: last.responseProvider || undefined,
            startedAt: session.startedAt,
            completedAt: last.createdAt,
            conversationId: session.conversationId,
            answerId: last.id,
            sourceTrace: last.sourceTrace,
            aiCalls: api,
            notes,
            messages,
            answers,
            checks: {
              everyCustomerTurnAnswered:
                messages.filter((m) => m.role === 'user').length === answers.length,
              actualOpenaiReply: api.items.some(
                (c) =>
                  c.provider === 'openai' && c.purpose === 'response' && c.outcome === 'accepted',
              ),
              traceStoredPerAnswer: answers.every(
                (a) => !!a.sourceTrace && a.linkage === 'recorded',
              ),
              externalOnlyAfterPreferred: traces.every(
                (t) =>
                  !t.stages.some((s) => s.scope === 'public_web') ||
                  (t.stages.findIndex((s) => s.scope === 'preferred_sites') <
                    t.stages.findIndex((s) => s.scope === 'public_web') &&
                    t.stages.some((s) => s.scope === 'preferred_sites')),
              ),
              allPreferredSitesInSearch: traces.every((t) =>
                t.stages
                  .filter((s) => s.scope === 'preferred_sites')
                  .every((s) => state.preferredDomains.every((d) => s.domains.includes(d))),
              ),
              privateTraceExcludedFromPublic: !JSON.stringify(
                currentMessages(session.conversationId),
              ).includes('sourceTrace'),
              noAutomaticProcurementApproval: notes.every((n) =>
                (n.offers || []).every((o) => !o.approved && o.confirmedAt === null),
              ),
              noChatExecutionErrors: session.errors.length === 0,
            },
            procurementAssessment: notes.flatMap((n) =>
              (n.offers || []).map((o) => ({
                title: o.title,
                url: o.url,
                assessment:
                  '会話中に取得した調達候補。必要数量の在庫・納期・発注条件は担当者確認。',
              })),
            ),
            simulation: {
              kind: 'customer_simulation',
              label: profile.label,
              questionAgent: '独立した質問専用エージェント（アプリ内部情報を非共有）',
              customerGoal: profile.customerGoal,
              turnCount: messages.filter((m) => m.role === 'user').length,
              customerProfile: { persona: profile.persona, privateFacts: profile.privateFacts },
              questionTurns: session.completedRounds.map((round) => {
                const question = read<{ id: string; message: string; intent: string }[]>(
                  join(agentDirectory, `round-${String(round).padStart(2, '0')}.json`),
                ).find((q) => q.id === profile.id)!;
                return { round, message: question.message, intent: question.intent };
              }),
              configuration: {
                decisionProvider: state.settings.decisionProvider,
                searchProvider: state.settings.searchProvider,
                responseModel: state.settings.responseModel,
                demoMode: state.demoMode,
              },
              technicalFindings: technical,
              review: review
                ? { verdict: review.verdict, summary: review.summary, findings: review.findings }
                : undefined,
              errors: session.errors,
            },
          },
        ];
      });
      const original = new Database(state.originalFile, { readonly: true });
      const originalUnchanged = JSON.stringify(snapshot(original)) === JSON.stringify(state.before);
      original.close();
      const report: SourceVerificationReport & {
        originalUnchanged: boolean;
        demoMode: boolean;
        settings: AppSettings;
      } = {
        testedAt: state.testedAt,
        initialPreferredDomains: state.preferredDomains,
        responseModel: state.settings.responseModel,
        scenarios,
        originalUnchanged,
        demoMode: state.demoMode,
        settings: state.settings,
      };
      write(join(root, 'results.json'), report);
      writeFileSync(
        join(root, 'transcript.md'),
        [
          '# 自然な顧客会話の実APIシミュレーション',
          '',
          ...scenarios.flatMap((s) => [
            `## ${s.simulation?.label}`,
            `会話ID：${s.conversationId}`,
            '',
            ...(s.messages || []).flatMap((m) => [
              `${m.role === 'user' ? 'お客様' : 'チャット'}：${m.content}`,
              '',
            ]),
          ]),
        ].join('\n'),
      );
      return report;
    }
  } finally {
    resetDbForTests();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
