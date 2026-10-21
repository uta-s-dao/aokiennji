// Shared display types; credentials and price configuration stay on the server.
export const PLAN_IDS = ['basic', 'standard', 'plus'] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export interface BillingPlan {
  id: PlanId;
  name: string;
  monthlyYen: number;
  apiLimitYen: number | null;
  configured: boolean;
}
export interface BillingReport {
  period: string;
  periodStart: string;
  periodEnd: string;
  revision: number;
  limitYen: number;
  spentYen: number;
  reservedYen: number;
  remainingYen: number;
  forecastYen: number | null;
  paused: boolean;
  stopped: boolean;
  stopReason: string | null;
  editableMaxYen: number;
  billing: {
    enabled: boolean;
    ready: boolean;
    testMode: boolean;
    status: string;
    paidPlan: PlanId | null;
    paidUntil: string | null;
    hasSubscription: boolean;
  };
  plans: BillingPlan[];
  pricing: { version: string; usdJpy: number; marginPercent: number; models: string[] };
  notificationsConfigured: boolean;
  notifications: {
    id: string;
    kind: string;
    message: string;
    status: string;
    created_at: string;
  }[];
  history: {
    id: string;
    kind: string;
    actor: string;
    detail: Record<string, unknown>;
    created_at: string;
  }[];
  reservations: {
    id: string;
    provider: string;
    model: string;
    createdAt: string;
    reservedYen: number;
    settledYen: number | null;
    holdReason: string | null;
    detail: Record<string, unknown>;
  }[];
}
