export type {
  ResearchBrief,
  Item,
  Field,
  Value,
  Question,
  CapabilityRule,
  PublicResult,
  ItemResult,
  ScopeAssessment,
  AnswerMutation,
  IntakeResponse,
  PublicEvidence,
} from "../generated/contracts";
import type { ResearchBrief } from "../generated/contracts";
export class AppError extends Error {
  constructor(
    public code: string,
    public status = 400,
    message = code,
  ) {
    super(message);
  }
}
export type InputEvent = {
  id: string;
  text: string;
  type: "customer_text" | "selection" | "field_edit";
};
export type Change = {
  itemId: string;
  key: string;
  text?: string;
  number?: number | null;
  unit?: string | null;
  status?: "known" | "unknown" | "skipped" | "not_applicable" | "conflict";
  quote: string;
  hardConstraint?: boolean;
  conflicts?: { text: string; number: number | null; unit: string | null }[];
};
export type Snapshot = {
  brief: ResearchBrief;
  inputs: InputEvent[];
  overflow: string[];
  fallbackCount: number;
  attachmentNames: string[];
  extractionFailed?: boolean;
  extractionError?: string;
  unresolvedInputs?: InputEvent[];
  recoveryOffered?: boolean;
};
export type Source = {
  id: string;
  version: number;
  label: string;
  public_allowed: number;
  ai_allowed: number;
  role: string;
  confirmation_stage: string;
  is_demo: number;
};
export type Attachment = {
  id: string;
  case_id: string;
  object_key: string;
  name: string;
  mime: string;
  byte_size: number;
  analysis: string;
  supersedes: string | null;
  expires_at: number;
};
export const id = () => crypto.randomUUID();
export const now = () => Date.now();
