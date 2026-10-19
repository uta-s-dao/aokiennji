import type { ProcurementOffer, ResearchFinding } from './contracts';

// Staff-only procurement history. These observations never establish current stock.
export type ProcurementContext =
  | { kind: 'offer'; conversationId: string; noteId: string; offerId: string }
  | { kind: 'order'; orderId: string; line: number };
export type ProcurementAction =
  'ordered' | 'received' | 'unavailable' | 'delayed' | 'cancelled' | 'returned' | 'void';
export interface ProcurementCase {
  id: string;
  contextKey: string;
  model: string;
  supplierKey: string;
  supplierName: string;
  url: string;
  quantity: number;
  receivedQuantity: number;
  status: 'ordered' | 'partial' | 'received' | 'unavailable' | 'cancelled' | 'returned' | 'void';
  delayed: boolean;
  isDemo: boolean;
  origin: 'staff' | 'app_order';
  createdAt: string;
  updatedAt: string;
  snapshot: { offer?: ProcurementOffer; findings?: ResearchFinding[]; productId?: string };
}
export interface ProcurementEvent {
  id: string;
  caseId: string | null;
  action: ProcurementAction | 'conditions_confirmed' | 'order_sent';
  createdAt: string;
  source: 'staff' | 'app_order';
  isDemo: boolean;
  note: string;
  snapshot: unknown;
}
export interface ProcurementHistory {
  model: string;
  supplierName: string;
  suggestedQuantity: number | null;
  isDemo: boolean;
  canStart: boolean;
  cases: ProcurementCase[];
  events: ProcurementEvent[];
  summary: {
    completed: number;
    unavailable: number;
    delayed: number;
    lastReceivedAt: string | null;
  };
}
