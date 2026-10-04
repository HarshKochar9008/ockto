// Processing history: workflow runs as a timeline (every activity attempt; a failure that a retry fixed is called out)
// and the audit log. Linked from Overview and Documents rather than tabbed: it is the operator's view.
import type { ReactNode } from 'react';
import type { AuditDto, RunDto, StepDto, WorkspaceDetail } from '../../../shared/schemas.ts';
import { useActivity } from '../api.ts';
import { ACTIVITIES, ACTORS, EVENTS, WORKFLOWS, fmtDateTime, fmtDuration, label, plural } from '../labels.ts';
import { Link, docHref } from '../router.tsx';
import { Badge, Card, EmptyState, Icon, Load, Notice, RunStatusBadge } from '../ui.tsx';

export function Activity({ ws }: { ws: WorkspaceDetail }) {
  const q = useActivity(ws.id, true);
  const subject = (r: RunDto) => {
    if (!r.subject_label) return undefined;
    if (!r.workflow_type.toLowerCase().includes('document')) return <span className="break-all">{r.subject_label}</span>;
    return <Link to={docHref(ws.id, r.subject_id!)} className="break-all hover:text-accent">{r.subject_label}</Link>;
  };
  return (
    <div className="space-y-6">
      <Link to={`/w/${ws.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-white/75 transition-colors hover:text-white">
        <Icon name="back" className="h-3.5 w-3.5" />Overview
      </Link>
      <Card title="Processing history"
        description="Uploads, analyses and reminders run as durable workflows. A failed step is retried automatically, and every attempt is listed here.">
        <Load q={q}>{(a) => a.runs.length
          ? <ol className="space-y-4">{a.runs.map((r) => <li key={r.id}><RunCard run={r} subject={subject(r)} /></li>)}</ol>
          : <EmptyState title="Nothing has run yet" icon="history">Upload a document to start one.</EmptyState>}
        </Load>
      </Card>
      <Card title="Audit log" description="Who did what, and when. Your decisions are always recorded.">
        <Load q={q}>{(a) => <AuditTable rows={a.audit} />}</Load>
      </Card>
    </div>
  );
}

/** The attempt that later succeeded after the failure at `steps[i]`, if any (Temporal retries are attempt + 1). */
function recoveredOn(steps: StepDto[], i: number): number | null {
  const { activity } = steps[i];
  let { attempt } = steps[i];
  for (const s of steps.slice(i + 1)) {
    if (s.activity !== activity || s.attempt !== attempt + 1) continue;
    if (s.outcome === 'completed') return s.attempt;
    attempt = s.attempt;
  }
  return null;
}

export function RunCard({ run, subject }: { run: RunDto; subject?: ReactNode }) {
  const steps = run.steps ?? [];
  const recovered = steps.map((s, i) => (s.outcome === 'failed' ? recoveredOn(steps, i) : null));
  const anyRecovered = recovered.some(Boolean);
  const anyFailed = steps.some((s) => s.outcome === 'failed');
  const took = (run.completed_at ? Date.parse(run.completed_at) : Date.now()) - Date.parse(run.started_at);
  return (
    <article className={`rounded-xl border p-4 sm:p-5 ${anyRecovered ? 'border-ok-line bg-ok-soft/50' : run.status === 'failed' ? 'border-crit-line' : 'border-line'}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{label(WORKFLOWS, run.workflow_type)}{subject && <span className="font-normal text-muted"> · {subject}</span>}</h3>
          <p className="mt-0.5 text-xs text-muted">Started {fmtDateTime(run.started_at)} · {run.completed_at ? 'took' : 'running for'} {fmtDuration(Math.max(0, took))}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <RunStatusBadge status={run.status} />
          {anyRecovered && <Badge tone="green">Recovered after retry</Badge>}
        </div>
      </header>
      {run.last_error_summary && <Notice tone={run.status === 'failed' ? 'error' : 'warn'} className="mt-3 break-words font-mono text-xs">{run.last_error_summary}</Notice>}
      {steps.length > 0 && (
        <details className="mt-3" open={run.status !== 'completed' || anyFailed}>
          <summary className="inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink">
            <Icon name="chevron" className="chev h-3.5 w-3.5 transition-transform" />{plural(steps.length, 'step attempt')}
          </summary>
          <ol className="ml-1.5 mt-3 space-y-3 border-l-2 border-line pl-4">
            {steps.map((s, i) => <Step key={s.id} s={s} recoveredOn={recovered[i]} />)}
          </ol>
        </details>
      )}
      <a href={run.temporal_url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
        View in Temporal UI<Icon name="arrow" className="h-3 w-3" />
      </a>
    </article>
  );
}

function Step({ s, recoveredOn: fixedBy }: { s: StepDto; recoveredOn: number | null }) {
  const failed = s.outcome === 'failed';
  return (
    <li className="relative">
      <span aria-hidden="true"
        className={`absolute -left-[23px] top-1 h-3 w-3 rounded-full ring-[3px] ring-surface ${!failed ? 'bg-ok-dot' : fixedBy ? 'bg-warn-dot' : 'bg-crit-dot'}`} />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">{label(ACTIVITIES, s.activity)}</span>
        <span className="text-xs text-muted">attempt {s.attempt}</span>
        <Badge tone={failed ? 'red' : 'green'}>{failed ? 'Failed' : 'Completed'}</Badge>
        <span className="text-xs tabular-nums text-muted">{fmtDuration(s.duration_ms)}</span>
        {failed && s.will_retry === true && <Badge tone="amber">Will retry</Badge>}
        {failed && s.will_retry === false && <Badge tone="red">Gave up</Badge>}
      </div>
      {s.error_summary && <p className="mt-1 break-words font-mono text-xs text-crit-ink">{s.error_summary}</p>}
      {fixedBy && <p className="mt-1 text-xs font-semibold text-ok-ink">↻ Retried automatically and succeeded on attempt {fixedBy}.</p>}
      {(s.sentry_url || s.trace_url) && (
        <p className="mt-1 flex gap-3 text-xs">
          {s.sentry_url && <a href={s.sentry_url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">Sentry event</a>}
          {s.trace_url && <a href={s.trace_url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">Trace</a>}
        </p>
      )}
    </li>
  );
}

const details = (m: Record<string, unknown>) => Object.entries(m)
  .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`)
  .join(' · ');

const ACTOR_TONES = { user: 'accent', ai: 'amber', system: 'gray' } as const;

function AuditTable({ rows }: { rows: AuditDto[] }) {
  if (!rows.length) return <p className="text-sm text-muted">No events yet.</p>;
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[36rem] text-left text-sm">
        <thead className="border-b border-line text-[11px] uppercase tracking-[0.08em] text-muted">
          <tr>{['Time', 'Actor', 'Event', 'Details'].map((h) => <th key={h} scope="col" className="py-2.5 pr-4 font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((a) => (
            <tr key={a.id} className="align-top">
              <td className="whitespace-nowrap py-2.5 pr-4 tabular-nums text-muted">{fmtDateTime(a.created_at)}</td>
              <td className="py-2.5 pr-4"><Badge tone={ACTOR_TONES[a.actor_type]}>{label(ACTORS, a.actor_type)}</Badge></td>
              <td className="py-2.5 pr-4 first-letter:uppercase">{label(EVENTS, a.event_type)}</td>
              <td className="break-words py-2.5 text-muted">{details(a.metadata)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
