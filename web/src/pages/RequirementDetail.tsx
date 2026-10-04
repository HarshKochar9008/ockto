// One requirement: what it asks, what the AI found (with the exact passages), and your decision.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { ChecklistDto, RequirementDto, WorkspaceDetail } from '../../../shared/schemas.ts';
import { api } from '../api.ts';
import { REVIEW_OPTIONS, STATUSES, assessedBy, fmtDate, fmtDateTime, label } from '../labels.ts';
import { Link, docHref } from '../router.tsx';
import { Button, Card, ErrorText, Icon, Load, Modal, Notice, Select, StatusBadge, Textarea, formValues } from '../ui.tsx';
import { BackLink } from './DocumentView.tsx';
import { AnalyzeButton } from './Overview.tsx';
import { TaskForm } from './Tasks.tsx';

export function RequirementDetail({ ws, rid }: { ws: WorkspaceDetail; rid: string }) {
  const q = useQuery({ queryKey: ['requirement', rid], queryFn: () => api<RequirementDto>(`/requirements/${rid}`) });
  return (
    <div className="space-y-5">
      <BackLink to={`/w/${ws.id}/requirements`}>All requirements</BackLink>
      <Load q={q}>{(r) => <Detail ws={ws} r={r} />}</Load>
    </div>
  );
}

function Detail({ ws, r }: { ws: WorkspaceDetail; r: RequirementDto }) {
  const c = r.checklist;
  const [tasking, setTasking] = useState(false);
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-6 lg:col-span-2">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="break-words font-display text-[2rem] leading-[1.1] tracking-[-0.01em]">{r.title}</h2>
              <p className="mt-2 text-sm text-muted">
                {[r.required ? 'Required' : 'Optional', r.due_date && `due ${fmtDate(r.due_date)}`, r.origin === 'ai' ? 'extracted by AI' : 'added by you']
                  .filter(Boolean).join(' · ')}
              </p>
            </div>
            <div className="sm:text-right">
              <StatusBadge c={c} />
              <p className="mt-1 text-xs text-muted">{assessedBy(r)}</p>
            </div>
          </div>
          {r.description && <p className="mt-5 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">{r.description}</p>}
          {r.ambiguity && <Notice tone="warn" className="mt-4"><strong>Ambiguous in the source:</strong> {r.ambiguity}</Notice>}
          {r.source_excerpt && (
            <figure className="mt-5 rounded-xl bg-surface-2 p-4">
              <figcaption className="text-xs font-medium uppercase tracking-[0.08em] text-muted">What the programme says</figcaption>
              <blockquote className="mt-2 border-l-2 border-line-strong pl-3 text-sm leading-relaxed text-ink-2">“{r.source_excerpt}”</blockquote>
              {r.source_document_id && (
                <Link to={docHref(ws.id, r.source_document_id, r.source_page, r.source_excerpt)} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                  <Icon name="file" className="h-3.5 w-3.5" />Open the source{r.source_page ? ` at page ${r.source_page}` : ''}
                </Link>
              )}
            </figure>
          )}
        </Card>

        {c?.stale && c.ai_status && (
          <Notice tone="warn">
            <p className="mb-3"><strong>This assessment is out of date.</strong> The requirement or your documents changed since it was made.</p>
            <AnalyzeButton ws={ws} size="sm" />
          </Notice>
        )}

        {c && (
          <Card title="Evidence" description={c.evidence.length ? `${c.evidence.length} passage${c.evidence.length === 1 ? '' : 's'} from your documents` : undefined}>
            {c.evidence.length ? (
              <ul className="space-y-3">
                {c.evidence.map((e) => (
                  <li key={e.id} className="rounded-xl border border-line p-4">
                    <blockquote className="border-l-2 border-accent pl-3 text-[15px] leading-relaxed text-ink">“{e.excerpt}”</blockquote>
                    {e.match_explanation && <p className="mt-2 text-sm text-muted">{e.match_explanation}</p>}
                    <Link to={docHref(ws.id, e.document_id, e.page_number, e.excerpt)} className="mt-3 inline-flex items-center gap-1.5 break-all text-xs font-medium text-accent hover:underline">
                      <Icon name="file" className="h-3.5 w-3.5" />{e.filename}{e.page_number ? `, page ${e.page_number}` : ''}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">{c.ai_status ? 'No supporting passage was found in your documents.' : 'No evidence yet.'}</p>
            )}
          </Card>
        )}

        {c && (
          <Card title="Assessment">
            {c.ai_status || c.explanation || c.review_reason ? (
              <dl className="space-y-4 text-sm">
                {c.review_reason && <Item term="Why it needs a closer look">{c.review_reason}</Item>}
                {c.explanation && <Item term="AI explanation">{c.explanation}</Item>}
                {c.user_verified && c.ai_status && c.ai_status !== c.status && (
                  <Item term="AI’s original status">{label(STATUSES, c.ai_status)}; you set it to {label(STATUSES, c.status)}.</Item>
                )}
                {c.user_note && <Item term="Your note">{c.user_note}</Item>}
                <Item term="Last updated">{fmtDateTime(c.updated_at)}</Item>
              </dl>
            ) : (
              <p className="text-sm text-muted">Not assessed yet. It runs once your documents are ready.</p>
            )}
          </Card>
        )}
      </div>

      <div className="space-y-6 lg:sticky lg:top-24 lg:self-start">
        {c ? <Review key={c.updated_at} c={c} /> : (
          <Card title="Draft">
            <p className="text-sm text-muted">This requirement is a draft. Confirm it on the Requirements page before it can be analysed or reviewed.</p>
          </Card>
        )}
        <Card title="Follow-up" description="Turn this into a task with a due date and reminders.">
          <Button onClick={() => setTasking(true)}><Icon name="plus" />Create a task</Button>
        </Card>
        <Modal open={tasking} onClose={() => setTasking(false)} title="New task">
          <TaskForm wsId={ws.id} checklistItemId={c?.id} defaultTitle={r.title} onDone={() => setTasking(false)} />
        </Modal>
      </div>
    </div>
  );
}

const Item = ({ term, children }: { term: string; children: ReactNode }) => (
  <div>
    <dt className="font-medium text-ink">{term}</dt>
    <dd className="mt-1 whitespace-pre-wrap leading-relaxed text-ink-2">{children}</dd>
  </div>
);

type ReviewPatch = { status?: string | null; user_note?: string | null; user_verified?: boolean };

/** A human decision overrides the AI's and is audited. Undo returns to the AI's status. */
function Review({ c }: { c: ChecklistDto }) {
  const review = useMutation({ mutationFn: (body: ReviewPatch) => api(`/checklist/${c.id}`, { method: 'PATCH', json: body }) });
  const undoing = review.isPending && review.variables?.user_verified === false;
  return (
    <Card emphasis={!c.user_verified} title="Your review"
      description={c.user_verified
        ? 'You verified this item. Your decision overrides the AI’s and is recorded in the activity log.'
        : 'Check the evidence, then confirm or correct the status. Your decision overrides the AI’s.'}>
      {c.user_verified && <p className="mb-4 flex items-center gap-2 text-sm font-medium text-ok-ink"><Icon name="check" />Verified by you</p>}
      <form className="space-y-4" onSubmit={(e) => {
        e.preventDefault();
        const v = formValues(e.currentTarget);
        review.mutate({ status: v.status, user_note: v.user_note });
      }}>
        <Select label="Status" name="status" defaultValue={c.status === 'pending' ? 'satisfied' : c.status}>
          {Object.entries(REVIEW_OPTIONS).map(([v, text]) => <option key={v} value={v}>{text}</option>)}
        </Select>
        <Textarea label="Note (optional)" name="user_note" rows={3} maxLength={2000} defaultValue={c.user_note ?? ''} />
        <ErrorText error={review.error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" busy={review.isPending && !undoing}><Icon name="check" />{c.user_verified ? 'Save' : 'Verify'}</Button>
          {c.user_verified && <Button variant="ghost" busy={undoing} onClick={() => review.mutate({ user_verified: false })}>Undo my verification</Button>}
        </div>
      </form>
    </Card>
  );
}
