// Shared by the server (validation, model output checks) and the web app (types, forms).
import { z } from 'zod';

export const CHECKLIST_STATUSES = ['pending', 'satisfied', 'needs_review', 'missing', 'expired', 'not_applicable'] as const;
export type ChecklistStatus = (typeof CHECKLIST_STATUSES)[number];
export const REVIEWABLE_STATUSES = ['satisfied', 'needs_review', 'missing', 'expired', 'not_applicable'] as const;

export const DOCUMENT_CLASSES = [
  'transcript', 'language_certificate', 'passport', 'id_card', 'resume', 'recommendation_letter',
  'personal_statement', 'diploma', 'financial_statement', 'requirements', 'other',
] as const;
export type DocumentClass = (typeof DOCUMENT_CLASSES)[number];

export const PROCESS_TYPES = ['university_application', 'scholarship', 'job_application', 'insurance_claim', 'other'] as const;

/** Activities that can be told to fail once, to demonstrate retries (DEMO_FAILURE_INJECTION=true). */
export const INJECTABLE_ACTIVITIES = ['extractText', 'classifyDocument', 'indexDocument', 'extractRequirements', 'assessRequirement', 'deliverReminder'] as const;

const isoDate = z.iso.date();

// ------------------------------------------------------------- model outputs
// The model must answer in exactly these shapes; anything else is rejected and re-asked.

export const AiRequirements = z.object({
  requirements: z.array(z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(2000),
    // Asked as `optional` (default false): small models get "required: false = optional" backwards.
    optional: z.boolean(),
    due_date: isoDate.nullable(),
    source_excerpt: z.string().max(1000),
    ambiguity: z.string().max(500).nullable(),
  })).max(60),
});

export const AiClassification = z.object({
  classification: z.enum(DOCUMENT_CLASSES),
  summary: z.string().max(400),
  document_date: isoDate.nullable(),
  expiry_date: isoDate.nullable(),
  expiry_quote: z.string().max(300).nullable(),
});

export const AiAssessment = z.object({
  status: z.enum(['satisfied', 'needs_review', 'missing', 'not_applicable']),
  explanation: z.string().max(1500),
  evidence: z.array(z.object({ passage: z.string().max(10), quote: z.string().max(600) })).max(5),
  uncertainty: z.string().max(600).nullable(),
});

export const AiAnswer = z.object({
  answer: z.string().max(4000),
  citations: z.array(z.string().max(10)).max(8),
  insufficient_evidence: z.boolean(),
});

// ----------------------------------------------------------------- API input

export const SignupInput = z.object({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(100).optional(), // defaults to the part of the email before the @
  password: z.string().min(10, 'Use at least 10 characters').max(200),
});
export const LoginInput = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) });

export const WorkspaceInput = z.object({
  name: z.string().trim().min(1).max(120),
  process_type: z.enum(PROCESS_TYPES).default('university_application'),
  institution: z.string().trim().max(200).nullish(),
  deadline: isoDate.nullish(),
  notes: z.string().max(5000).nullish(),
});
export const WorkspacePatch = WorkspaceInput.partial().extend({ status: z.enum(['active', 'archived']).optional() });

export const RequirementInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).default(''),
  required: z.boolean().default(true),
  due_date: isoDate.nullish(),
});
export const RequirementPatch = RequirementInput.partial();
export const RequirementsTextInput = z.object({ text: z.string().trim().min(20).max(50_000) });

export const ChecklistPatch = z.object({
  status: z.enum(REVIEWABLE_STATUSES).optional(),
  user_verified: z.boolean().optional(),
  user_note: z.string().max(2000).nullish(),
});

export const TaskInput = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(2000).nullish(),
  due_at: z.iso.datetime({ offset: true }).nullish(),
  checklist_item_id: z.uuid().nullish(),
});
export const TaskPatch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  notes: z.string().max(2000).nullish(),
  due_at: z.iso.datetime({ offset: true }).nullish(),
  status: z.enum(['open', 'done', 'dismissed']).optional(),
});
export const ReminderInput = z.object({
  remind_at: z.array(z.iso.datetime({ offset: true })).min(1).max(10),
  inject_failure: z.enum(INJECTABLE_ACTIVITIES).optional(),
});

export const AnalyzeInput = z.object({ inject_failure: z.enum(INJECTABLE_ACTIVITIES).optional() }).default({});
export const SearchInput = z.object({ query: z.string().trim().min(2).max(500) });
export const AskInput = z.object({ question: z.string().trim().min(2).max(1000) });

// ------------------------------------------------------------ API responses

export interface Me { id: string; email: string; name: string }

export interface SystemStatus {
  ai: { base_url: string; chat_model: string; embedding_model: string; ocr_model: string | null };
  storage: 'local' | 's3';
  sentry: boolean;
  reminder_webhook: boolean;
  temporal_ui_url: string;
  demo_failure_injection: boolean;
}

export interface Counts {
  requirements: number; pending: number; satisfied: number; satisfied_verified: number; needs_review: number; missing: number;
  expired: number; not_applicable: number; verified: number;
  documents: number; processing: number; failed_documents: number; open_tasks: number;
}

export interface WorkspaceSummary {
  id: string; name: string; process_type: string; institution: string | null; deadline: string | null;
  status: 'active' | 'archived'; created_at: string; updated_at: string;
  counts: Counts; next_due_at: string | null;
}

export interface NextAction {
  // 'processing': something is being read; nothing to click, just say so.
  kind: 'add_requirements' | 'confirm_requirements' | 'upload' | 'analyze' | 'review' | 'renew' | 'fix_document' | 'processing';
  title: string; detail: string; requirement_id?: string; document_id?: string;
}

export interface WorkspaceDetail extends WorkspaceSummary {
  notes: string | null; requirements_confirmed_at: string | null; assessment_version: number;
  analysis: RunDto | null; stale_analysis: boolean; next_actions: NextAction[];
}

export interface DocumentDto {
  id: string; workspace_id: string; role: 'requirements' | 'evidence'; filename: string; mime_type: string;
  size_bytes: number; classification: string | null; summary: string | null; document_date: string | null;
  expiry_date: string | null; page_count: number | null;
  processing_status: 'queued' | 'processing' | 'ready' | 'failed'; processing_error: string | null; created_at: string;
}
export interface DocumentDetail extends DocumentDto { pages: string[] | null; runs: RunDto[] }

export interface EvidenceDto {
  id: string; document_id: string; filename: string; page_number: number | null; excerpt: string;
  match_explanation: string | null; chunk_id: string | null; assessment_version: number;
}
export interface ChecklistDto {
  id: string; status: ChecklistStatus; ai_status: ChecklistStatus | null; explanation: string | null;
  review_reason: string | null; user_verified: boolean; user_note: string | null; assessment_version: number;
  stale: boolean; updated_at: string; evidence: EvidenceDto[];
}
export interface RequirementDto {
  id: string; title: string; description: string; required: boolean; due_date: string | null;
  source_document_id: string | null; source_page: number | null; source_excerpt: string | null;
  ambiguity: string | null; origin: 'ai' | 'user'; confirmed: boolean; version: number;
  checklist: ChecklistDto | null;
}

export interface ReminderDto {
  id: string; scheduled_at: string; delivery_status: 'scheduled' | 'sent' | 'suppressed' | 'cancelled' | 'failed';
  channel: string | null; detail: string | null; sent_at: string | null;
}
export interface TaskDto {
  id: string; workspace_id: string; workspace_name?: string; checklist_item_id: string | null; title: string;
  notes: string | null; due_at: string | null; status: 'open' | 'done' | 'dismissed'; origin: 'user' | 'analysis';
  created_at: string; reminders: ReminderDto[];
}

export interface StepDto {
  id: number; activity: string; attempt: number; outcome: 'completed' | 'failed'; duration_ms: number;
  error_summary: string | null; will_retry: boolean | null; sentry_url: string | null; trace_url: string | null; created_at: string;
}
export interface RunDto {
  id: string; workflow_id: string; workflow_type: string; subject_id: string | null;
  /** The document file name or task title the run is about. */
  subject_label: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled'; started_at: string; completed_at: string | null;
  last_error_summary: string | null; temporal_url: string; steps?: StepDto[];
}
export interface AuditDto {
  id: string; workspace_id: string; workspace_name?: string; actor_type: 'user' | 'system' | 'ai';
  event_type: string; entity_type: string; entity_id: string | null; metadata: Record<string, unknown>; created_at: string;
}

export interface SearchHit {
  chunk_id: string; document_id: string; filename: string; role: 'requirements' | 'evidence';
  page_number: number | null; content: string; score: number;
}
export interface Citation { ref: string; document_id: string; filename: string; page_number: number | null; chunk_id: string; excerpt: string }
export interface AnswerDto { answer: string; insufficient_evidence: boolean; citations: Citation[] }

export interface DashboardDto {
  workspaces: WorkspaceSummary[];
  upcoming: TaskDto[];
  processing: (DocumentDto & { workspace_name: string })[];
  activity: AuditDto[];
}
