import type {
  AiAnswer,
  AiUsageReport,
  ChatMessage,
  Conversation,
  ResearchNote,
  SourceTrace,
  StoredChatMessage,
} from './contracts';

export interface AdminConversation extends Conversation {
  verification?: {
    id: string;
    responseModel: string;
    preferredSiteCount: number;
    kind?: 'customer_simulation';
    turnCount?: number;
  };
}
export interface AdminConversationDetail {
  conversation: AdminConversation;
  messages: ChatMessage[];
  research: ResearchNote[];
  answers: AiAnswer[];
  verification?: SourceVerificationScenario;
}

export interface SourceVerificationScenario {
  id: string;
  question: string;
  response: string;
  responseProvider: ChatMessage['responseProvider'];
  startedAt: string;
  completedAt: string;
  conversationId: string;
  answerId: string;
  sourceTrace: SourceTrace;
  aiCalls: AiUsageReport;
  checks: Record<string, boolean>;
  notes: ResearchNote[];
  procurementAssessment: { title: string; url: string; assessment: string }[];
  messages?: StoredChatMessage[];
  answers?: AiAnswer[];
  simulation?: {
    kind: 'customer_simulation';
    label: string;
    questionAgent: string;
    customerGoal: string;
    turnCount: number;
    customerProfile: { persona: string; privateFacts: Record<string, unknown> };
    questionTurns: { round: number; message: string; intent: string }[];
    configuration: {
      decisionProvider: string;
      searchProvider: string;
      responseModel: string;
      demoMode: boolean;
    };
    technicalFindings?: {
      turn: number;
      severity: string;
      detail: string;
      evidence: string;
      answerId: string;
    }[];
    review?: {
      verdict: 'pass' | 'needs_review' | 'fail';
      summary: string;
      findings: { turn: number; severity: string; detail: string }[];
    };
    errors: { round: number; message: string }[];
    customerUiErrors?: { round: number; message: string }[];
    quoteOutcome?: {
      requestId: string;
      status: string;
      lineName: string;
      quantity: number;
      issued: boolean;
      ordered: boolean;
      blockers: string[];
    };
  };
}
export interface SourceVerificationReport {
  testedAt: string;
  initialPreferredDomains: string[];
  responseModel: string;
  scenarios: SourceVerificationScenario[];
}
