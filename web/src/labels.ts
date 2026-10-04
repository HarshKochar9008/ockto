// Display text for server values, and formatting. Pure functions only: the server
// decides statuses, next actions and staleness; this file only names them.
import type {
  ChecklistDto, ChecklistStatus, DOCUMENT_CLASSES, INJECTABLE_ACTIVITIES, PROCESS_TYPES, REVIEWABLE_STATUSES, ReminderDto, RequirementDto, RunDto,
} from '../../shared/schemas.ts';

/** Label for a key, falling back to the key itself for values this build doesn't know yet. */
export const label = (map: Record<string, string>, key: string | null | undefined) => (key ? (map[key] ?? key.replace(/_/g, ' ')) : '—');

export const PROCESSES: Record<(typeof PROCESS_TYPES)[number], string> = {
  university_application: 'University application', scholarship: 'Scholarship', job_application: 'Job application',
  insurance_claim: 'Insurance claim', other: 'Other',
};

export const DOC_CLASSES: Record<(typeof DOCUMENT_CLASSES)[number], string> = {
  transcript: 'Transcript', language_certificate: 'Language certificate', passport: 'Passport', id_card: 'ID card',
  resume: 'CV / résumé', recommendation_letter: 'Recommendation letter', personal_statement: 'Personal statement',
  diploma: 'Diploma', financial_statement: 'Financial statement', requirements: 'Requirements', other: 'Other',
};

export const STATUSES: Record<ChecklistStatus, string> = {
  pending: 'Not assessed', satisfied: 'Evidence found', needs_review: 'Needs review', missing: 'Missing',
  expired: 'Expired', not_applicable: 'Not applicable',
};

/** What the user can set when verifying an item. */
export const REVIEW_OPTIONS: Record<(typeof REVIEWABLE_STATUSES)[number], string> = {
  satisfied: 'Satisfied: the evidence is right', needs_review: 'Needs review', missing: 'Missing', expired: 'Expired', not_applicable: 'Not applicable',
};

/** Checklist display groups, in display order. "Found by the AI" and "verified by you" are kept apart. */
export const GROUPS = {
  expired: 'Expired', missing: 'Missing', needs_review: 'Needs review', evidence: 'Evidence found',
  verified: 'Verified', not_applicable: 'Not applicable', pending: 'Not assessed',
};
export type Group = keyof typeof GROUPS;

export const groupOf = (c: Pick<ChecklistDto, 'status' | 'user_verified'> | null): Group =>
  !c ? 'pending' : c.status === 'satisfied' ? (c.user_verified ? 'verified' : 'evidence') : c.status;

export const assessedBy = (r: RequirementDto) =>
  !r.confirmed ? 'Draft' : r.checklist?.user_verified ? 'Verified by you' : r.checklist?.ai_status ? 'AI assessment (unverified)' : 'Not assessed';

export const WORKFLOWS: Record<string, string> = {
  processDocument: 'Process document', retryFailedProcessing: 'Retry failed processing', analyzeWorkspace: 'Analyze workspace', reminder: 'Reminders',
};

export const ACTIVITIES: Record<(typeof INJECTABLE_ACTIVITIES)[number], string> & Record<string, string> = {
  extractText: 'Extract text', classifyDocument: 'Classify document', indexDocument: 'Index for search',
  extractRequirements: 'Extract requirements', assessRequirement: 'Assess requirement', deliverReminder: 'Deliver reminder',
  startDocument: 'Start processing', finishDocument: 'Save result', inspectDocument: 'Check what is missing',
  requirementsToAssess: 'List requirements', markAssessmentFailed: 'Flag for review', syncTasks: 'Update tasks',
  failReminder: 'Record failed reminder', closeReminders: 'Close reminders', finishRun: 'Record outcome',
};

export const RUN_STATUSES: Record<RunDto['status'], string> = { running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };

export const REMINDER_STATUSES: Record<ReminderDto['delivery_status'], string> = {
  scheduled: 'Scheduled', sent: 'Sent', suppressed: 'Suppressed', cancelled: 'Cancelled', failed: 'Failed',
};

export const ACTORS: Record<string, string> = { user: 'You', ai: 'AI', system: 'System' };

/** Verb phrases, so "You uploaded a document" reads naturally. */
export const EVENTS: Record<string, string> = {
  'workspace.created': 'created the workspace', 'workspace.updated': 'updated the workspace',
  'document.uploaded': 'uploaded a document', 'document.deleted': 'deleted a document', 'document.retry': 'retried processing',
  'requirement.added': 'added a requirement', 'requirement.edited': 'edited a requirement', 'requirement.deleted': 'deleted a requirement',
  'requirements.extracted': 'extracted draft requirements', 'requirements.confirmed': 'confirmed the requirements',
  'analysis.started': 'started the analysis', 'assessment.changed': 'changed an assessment', 'checklist.reviewed': 'reviewed a checklist item',
  'task.created': 'created a task', 'task.status_changed': 'changed a task status', 'task.deleted': 'deleted a task',
  'reminders.scheduled': 'scheduled reminders', 'reminders.cancelled': 'cancelled reminders', 'reminder.sent': 'sent a reminder',
};

// ----------------------------------------------------------------- formatting

/** 'YYYY-MM-DD' is a calendar day (local midnight); anything else is an instant. */
const toDate = (s: string) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00` : s);
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const fmtDate = (s: string | null) => (s ? dateFmt.format(toDate(s)) : '—');
export const fmtDateTime = (s: string | null) => (s ? dateTimeFmt.format(toDate(s)) : '—');
/** ISO-shaped local wall-clock time: 'YYYY-MM-DDTHH:mm:ss.sss'. */
const localIso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
/** Today as 'YYYY-MM-DD' in local time, comparable with date columns. */
export const today = (now = new Date()) => localIso(now).slice(0, 10);
/** Whole days from today to a calendar day; negative once it has passed. */
export const daysUntil = (day: string, now = new Date()) => Math.round((toDate(day).getTime() - toDate(today(now)).getTime()) / 86_400_000);
export const countdown = (n: number) =>
  n === 0 ? 'Due today' : n > 0 ? `${n} day${n === 1 ? '' : 's'} left` : `${-n} day${n === -1 ? '' : 's'} overdue`;

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.round(n / 1024)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);
export const fmtDuration = (ms: number) =>
  ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

/** ISO instant <-> the local 'YYYY-MM-DDTHH:mm' a datetime-local input uses. */
export const toLocalInput = (iso: string | null) => (iso ? localIso(new Date(iso)).slice(0, 16) : '');
export const fromLocalInput = (v: string) => new Date(v).toISOString();

/**
 * Case- and whitespace-insensitive pattern for a quoted excerpt (PDF text wraps
 * differently from the quote). `maxWords` keeps only the start, for quotes that run past a page.
 */
export function excerptPattern(q: string | null, maxWords = Infinity): RegExp | null {
  const words = (q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, maxWords);
  return words.length ? new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'gi') : null;
}
