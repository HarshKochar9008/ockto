// Application home. One card says what to do next (with the setup steps until the first checklist exists);
// once requirements are confirmed: progress, analysis state, and the checklist by status.
import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { DocumentDto, NextAction, RequirementDto, WorkspaceDetail } from '../../../shared/schemas.ts';
import { api, isProcessing, useDocuments, useRequirements, useTasks } from '../api.ts';
import { GROUPS, fmtDateTime, groupOf, plural, type Group } from '../labels.ts';
import { Link } from '../router.tsx';
import {
  Badge, Button, Card, Elapsed, ErrorText, FailureToggle, GROUP_COLORS, Icon, Load, Notice, PROCESSING_HINT, Spinner, StatusBadge, StatusBar,
  buttonClass,
} from '../ui.tsx';

export function Overview({ ws }: { ws: WorkspaceDetail }) {
  const reqs = useRequirements(ws.id);
  const docs = useDocuments(ws.id);
  const tasks = useTasks(ws.id);
  const base = `/w/${ws.id}`;
  const confirmed = reqs.data?.filter((r) => r.confirmed) ?? [];
  const open = tasks.data?.filter((t) => t.status === 'open') ?? [];

  return (
    <div className="space-y-6">
      {confirmed.length ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="min-w-0 lg:col-span-2"><NextSteps ws={ws} reqs={reqs.data ?? []} docs={docs.data ?? []} /></div>
          <div className="space-y-6">
            <ProgressCard reqs={confirmed} />
            <AnalysisCard ws={ws} />
          </div>
        </div>
      ) : (
        <NextSteps ws={ws} reqs={reqs.data ?? []} docs={docs.data ?? []} />
      )}

      {confirmed.length > 0 && <Load q={reqs}>{(list) => <Checklist ws={ws} reqs={list} />}</Load>}

      {open.length > 0 && (
        <Card title="Open tasks" actions={<Link to={`${base}/tasks`} className="text-sm font-medium text-accent hover:underline">All tasks</Link>}>
          <ul className="-my-2 divide-y divide-line">
            {open.slice(0, 4).map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t.title}</p>
                  <p className="mt-0.5 text-xs text-muted">{t.due_at ? `Due ${fmtDateTime(t.due_at)}` : 'No due date'}</p>
                </div>
                <Badge tone={t.origin === 'analysis' ? 'accent' : 'gray'}>{t.origin === 'analysis' ? 'From analysis' : 'Yours'}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <HistoryLink wsId={ws.id} />
    </div>
  );
}

/** Where the workflow runs live (retries, timings, Temporal and Sentry links). Linked, not tabbed. */
export const HistoryLink = ({ wsId }: { wsId: string }) => (
  <p className="print:hidden">
    <Link to={`/w/${wsId}/activity`} className="inline-flex items-center gap-1.5 text-sm font-medium text-white/75 transition-colors hover:text-white">
      <Icon name="history" />Processing history
    </Link>
  </p>
);

const segments = (reqs: RequirementDto[]) => (Object.keys(GROUPS) as Group[]).map((g) => ({
  label: GROUPS[g], count: reqs.filter((r) => groupOf(r.checklist) === g).length, color: GROUP_COLORS[g],
}));

// ------------------------------------------------------------- next steps

// How each server-computed action is presented: dot colour, button text, where it leads.
const ACTIONS: Record<NextAction['kind'], { dot: string; button?: string; to?: (a: NextAction) => string }> = {
  fix_document: { dot: 'bg-crit-dot', button: 'Open document', to: (a) => `documents/${a.document_id}` },
  renew: { dot: 'bg-crit-dot', button: 'See details', to: (a) => `requirements/${a.requirement_id}` },
  upload: { dot: 'bg-bad-dot', button: 'Upload documents', to: () => 'documents' },
  review: { dot: 'bg-warn-dot', button: 'Review', to: (a) => `requirements/${a.requirement_id}` },
  add_requirements: { dot: 'bg-accent', button: 'Add requirements', to: () => 'requirements' },
  confirm_requirements: { dot: 'bg-accent', button: 'Review and confirm', to: () => 'requirements' },
  analyze: { dot: 'bg-accent' }, // the analysis button itself
  processing: { dot: 'bg-accent' }, // nothing to click: it is being read
};

function NextSteps({ ws, reqs, docs }: { ws: WorkspaceDetail; reqs: RequirementDto[]; docs: DocumentDto[] }) {
  const actions = ws.next_actions;
  const firstClickable = actions.findIndex((a) => a.kind !== 'processing');
  const setup = ws.analysis?.status !== 'completed';
  return (
    <Card emphasis title="What to do next" description={setup ? 'Four steps to your first evidence-backed checklist.' : undefined}>
      {setup && <SetupSteps ws={ws} reqs={reqs} docs={docs} />}
      {actions.length ? (
        <ol className={`divide-y divide-line ${setup ? 'mt-5 border-t border-line' : '-my-2'}`}>
          {actions.map((a, i) => {
            const k = ACTIONS[a.kind];
            const dot = a.kind === 'upload' && !a.requirement_id ? 'bg-accent' : k.dot;
            const doc = a.kind === 'processing' ? docs.find((d) => d.id === a.document_id) : undefined;
            return (
              <li key={`${a.kind}:${a.requirement_id ?? a.document_id ?? i}`} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                <div className="flex min-w-0 gap-3">
                  {a.kind === 'processing'
                    ? <span className="mt-0.5 text-accent"><Spinner /></span>
                    : <span className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />}
                  <div className="min-w-0">
                    <p className="break-words text-[15px] font-medium text-ink">{a.title}</p>
                    <p className="mt-0.5 break-words text-sm text-muted">{a.detail}</p>
                    {a.kind === 'processing' && (
                      <p className="mt-1.5 text-xs text-muted">
                        {doc && <><span className="font-medium text-ink-2"><Elapsed since={doc.created_at} /></span> elapsed. </>}{PROCESSING_HINT}
                      </p>
                    )}
                  </div>
                </div>
                {a.kind !== 'processing' && (
                  <div className="shrink-0 pl-5 sm:pl-0">
                    {a.kind === 'analyze'
                      ? <AnalyzeButton ws={ws} size="sm" />
                      : <Link to={`/w/${ws.id}/${k.to!(a)}`} className={buttonClass(i === firstClickable ? 'primary' : 'secondary', 'sm')}>{k.button}</Link>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className={`text-sm text-muted ${setup ? 'mt-5 border-t border-line pt-4' : ''}`}>
          {ws.analysis?.status === 'running'
            ? 'Checking each requirement against your documents. Results appear below as they’re ready.'
            : 'Nothing outstanding. Before you submit, open each item and check the evidence yourself.'}
        </p>
      )}
    </Card>
  );
}

/** The four steps to a first checklist, derived from what exists. Shown until an analysis has completed. */
function SetupSteps({ ws, reqs, docs }: { ws: WorkspaceDetail; reqs: RequirementDto[]; docs: DocumentDto[] }) {
  const reading = (role: DocumentDto['role']) => docs.some((d) => d.role === role && isProcessing(d));
  const evidenceReady = docs.some((d) => d.role === 'evidence' && d.processing_status === 'ready');
  const drafts = reqs.filter((r) => !r.confirmed).length;
  const steps: { title: string; done: boolean; busy?: boolean }[] = [
    { title: 'Add the requirements', done: reqs.length > 0, busy: reading('requirements') },
    { title: 'Confirm them', done: reqs.length > 0 && drafts === 0 },
    { title: 'Add your documents', done: evidenceReady, busy: reading('evidence') },
    { title: 'Get your checklist', done: ws.analysis?.status === 'completed', busy: ws.analysis?.status === 'running' },
  ];
  const current = steps.findIndex((s) => !s.done);
  return (
    <ol className="grid gap-3 sm:grid-cols-4">
      {steps.map((s, i) => {
        const state = s.done ? 'done' : i === current ? 'current' : 'todo';
        return (
          <li key={s.title} aria-current={state === 'current' ? 'step' : undefined}
            className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 sm:flex-col sm:items-start sm:gap-2 sm:py-3 ${
              state === 'current' ? 'border-accent-line bg-accent-soft/60' : 'border-line bg-surface-2'}`}>
            <StepMark state={state} n={i + 1} busy={s.busy} />
            <span className={`text-sm font-medium ${state === 'todo' ? 'text-muted' : 'text-ink'}`}>
              {s.title}
              {s.busy && !s.done && <span className="block text-xs font-normal text-accent-ink">In progress…</span>}
              <span className="sr-only">{state === 'done' ? ' (done)' : state === 'current' ? ' (current step)' : ''}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StepMark({ state, n, busy }: { state: 'done' | 'current' | 'todo'; n: number; busy?: boolean }): ReactNode {
  if (state === 'done') return <span className="grid h-6 w-6 place-items-center rounded-full bg-ok text-white"><Icon name="check" className="h-3.5 w-3.5" /></span>;
  if (busy) return <span className="grid h-6 w-6 place-items-center rounded-full bg-accent-solid text-white"><Spinner className="h-3.5 w-3.5" /></span>;
  return (
    <span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-semibold ${state === 'current' ? 'bg-accent-solid text-white' : 'bg-sunken text-muted'}`}>{n}</span>
  );
}

// ------------------------------------------------------- analysis & progress

/**
 * Starts the analysis. Primary only when the server says it's the next thing to do; disabled until it can run
 * (the server would refuse with a 409 when nothing is confirmed or one is already running).
 */
export function AnalyzeButton({ ws, size, demo = false }: { ws: WorkspaceDetail; size?: 'sm' | 'md'; demo?: boolean }) {
  const [inject, setInject] = useState<string>();
  const run = useMutation({ mutationFn: () => api(`/workspaces/${ws.id}/analyze`, { json: inject ? { inject_failure: inject } : {} }) });
  const running = ws.analysis?.status === 'running';
  const due = ws.next_actions.some((a) => a.kind === 'analyze');
  const canRun = due || Boolean(ws.analysis);
  return (
    <div className="space-y-3">
      <Button variant={due ? 'primary' : 'secondary'} size={size} busy={run.isPending} disabled={running || !canRun}
        title={canRun ? undefined : 'Confirm the requirements and add a document first'} onClick={() => run.mutate()}>
        {running ? <><Spinner />Analysis running…</> : ws.analysis ? 'Run the analysis again' : 'Run the analysis'}
      </Button>
      {demo && <FailureToggle activities={['assessRequirement']} value={inject} onChange={setInject} />}
      <ErrorText error={run.error} />
    </div>
  );
}

function AnalysisCard({ ws }: { ws: WorkspaceDetail }) {
  const a = ws.analysis;
  return (
    <Card title="Analysis">
      <div aria-live="polite" className="space-y-3 text-sm">
        {a?.status === 'running' ? (
          <p className="flex items-start gap-2 text-accent-ink"><Spinner className="mt-0.5 h-4 w-4" />Checking each requirement against your documents. Results appear as they’re ready.</p>
        ) : ws.stale_analysis ? (
          <Notice tone="warn"><strong>Results may be out of date.</strong> Documents or requirements changed since the last analysis.</Notice>
        ) : a ? (
          <p className="text-ink-2">Last {a.status === 'failed' ? 'attempt failed' : 'checked'} {fmtDateTime(a.completed_at ?? a.started_at)}.</p>
        ) : (
          <p className="text-ink-2">Starts by itself once your requirements are confirmed and a document is ready.</p>
        )}
        {a?.last_error_summary && a.status !== 'running' && (
          <Notice tone={a.status === 'failed' ? 'error' : 'warn'}>
            {a.last_error_summary}. <Link to={`/w/${ws.id}/activity`} className="font-medium underline">See processing history</Link>
          </Notice>
        )}
      </div>
      <div className="mt-4"><AnalyzeButton ws={ws} demo /></div>
    </Card>
  );
}

function ProgressCard({ reqs }: { reqs: RequirementDto[] }) {
  const verified = reqs.filter((r) => r.checklist?.user_verified).length;
  return (
    <Card title="Progress">
      <p className="flex items-baseline gap-2">
        <span className="font-display text-[3rem] leading-none tabular-nums">{verified}</span>
        <span className="text-sm text-muted">of {plural(reqs.length, 'requirement')} verified by you</span>
      </p>
      <div className="mt-5"><StatusBar segments={segments(reqs)} /></div>
    </Card>
  );
}

// ------------------------------------------------------------------ checklist

function Checklist({ ws, reqs }: { ws: WorkspaceDetail; reqs: RequirementDto[] }) {
  const confirmed = reqs.filter((r) => r.confirmed);
  const drafts = reqs.length - confirmed.length;
  return (
    <Card title="Checklist" description="Grouped by what needs you first. Open an item to see the passage behind it."
      actions={drafts > 0 && (
        <Link to={`/w/${ws.id}/requirements`} className="text-sm font-medium text-accent hover:underline">{plural(drafts, 'draft')} to confirm</Link>
      )}>
      <div className="space-y-6">
        {(Object.keys(GROUPS) as Group[]).map((g) => {
          const rows = confirmed.filter((r) => groupOf(r.checklist) === g);
          return rows.length > 0 && (
            <section key={g} aria-label={GROUPS[g]}>
              <h3 className="flex items-center gap-2 text-[13px] font-semibold text-ink-2">
                <span className={`h-2 w-2 rounded-full ${GROUP_COLORS[g]}`} aria-hidden="true" />{GROUPS[g]}
                <span className="font-medium tabular-nums text-faint">{rows.length}</span>
              </h3>
              <ul className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line">
                {rows.map((r) => {
                  const c = r.checklist;
                  const reason = c?.review_reason ?? c?.explanation;
                  return (
                    <li key={r.id} className="group relative flex flex-col gap-2 bg-surface px-4 py-3.5 transition-colors hover:bg-surface-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                      <div className="min-w-0">
                        <Link to={`/w/${ws.id}/requirements/${r.id}`} className="break-words text-sm font-medium text-ink after:absolute after:inset-0 group-hover:text-accent">
                          {r.title}
                        </Link>
                        {!r.required && <span className="ml-2 text-xs text-muted">Optional</span>}
                        {reason && <p className="mt-1 line-clamp-2 text-sm text-muted">{reason}</p>}
                        {c && (c.evidence.length > 0 || (c.stale && c.ai_status)) && (
                          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                            {c.evidence.length > 0 && <span className="inline-flex items-center gap-1"><Icon name="quote" className="h-3 w-3" />{plural(c.evidence.length, 'source')}</span>}
                            {c.stale && c.ai_status && <span className="text-warn-ink">Out of date</span>}
                          </p>
                        )}
                      </div>
                      <StatusBadge c={c} />
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </Card>
  );
}
