// Printable completion report, matching the CSV export. Print CSS hides the app chrome and buttons.
import type { Counts, WorkspaceDetail } from '../../../shared/schemas.ts';
import { useRequirements } from '../api.ts';
import { assessedBy, fmtDate, fmtDateTime } from '../labels.ts';
import { Button, Icon, Load, Logo, Notice, StatusBadge, buttonClass } from '../ui.tsx';

const COUNTS: [string, keyof Counts][] = [
  ['Requirements', 'requirements'], ['Satisfied', 'satisfied'], ['Verified by you', 'verified'], ['Needs review', 'needs_review'],
  ['Missing', 'missing'], ['Expired', 'expired'], ['Not applicable', 'not_applicable'], ['Not assessed', 'pending'],
];

export function Report({ ws }: { ws: WorkspaceDetail }) {
  const reqs = useRequirements(ws.id);
  return (
    <Load q={reqs}>{(list) => (
      <article className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-10 print:border-0 print:p-0 print:shadow-none">
        <div className="mb-8 flex flex-wrap justify-end gap-2 print:hidden">
          <Button onClick={() => window.print()}>Print or save as PDF</Button>
          <a href={`/api/v1/workspaces/${ws.id}/report.csv`} download className={buttonClass()}>Download CSV</a>
        </div>

        <header className="border-b border-line pb-6">
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.08em] text-muted"><Logo tone="paper" still className="h-6 w-6" />PaperTrail completion report</p>
          <h2 className="mt-4 break-words font-display text-[2.5rem] leading-[1.05] tracking-[-0.01em]">{ws.name}</h2>
          <p className="mt-2 text-sm text-ink-2">
            {[ws.institution, ws.deadline && `Deadline ${fmtDate(ws.deadline)}`].filter(Boolean).join(' · ')}
          </p>
          <p className="mt-1 text-xs text-muted">Generated {fmtDateTime(new Date().toISOString())}</p>
        </header>

        <Notice tone="warn" className="mt-6 flex items-start gap-2">
          <Icon name="alert" className="mt-0.5" />
          <span>
            This report summarises AI-assisted assessments of your own documents. Items marked “AI assessment (unverified)” have not been checked by you.
            It is not verified compliance and does not guarantee eligibility or acceptance: the institution’s own rules and decisions apply.
          </span>
        </Notice>

        <dl className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {COUNTS.map(([text, k]) => (
            <div key={k} className="break-inside-avoid rounded-xl border border-line bg-surface-2 p-4">
              <dt className="text-xs text-muted">{text}</dt>
              <dd className="mt-1 font-display text-[2rem] leading-none tabular-nums">{ws.counts[k]}</dd>
            </div>
          ))}
        </dl>

        <h3 className="mt-10 text-[15px] font-semibold">Requirements</h3>
        <div className="mt-3 overflow-x-auto print:overflow-visible">
          <table className="w-full min-w-[46rem] border-collapse text-left text-sm print:min-w-0">
            <thead>
              <tr className="border-b border-line-strong text-[11px] uppercase tracking-[0.08em] text-muted">
                {['Requirement', 'Required', 'Status', 'Assessed by', 'Evidence', 'Explanation'].map((h) => <th key={h} scope="col" className="py-2.5 pr-4 font-semibold">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((r) => {
                const c = r.checklist;
                return (
                  <tr key={r.id} className="break-inside-avoid align-top">
                    <td className="py-3 pr-4 font-medium">{r.title}</td>
                    <td className="py-3 pr-4 text-ink-2">{r.required ? 'Required' : 'Optional'}</td>
                    <td className="py-3 pr-4"><StatusBadge c={c} /></td>
                    <td className="py-3 pr-4 text-ink-2">{assessedBy(r)}</td>
                    <td className="py-3 pr-4 text-ink-2">
                      {c?.evidence.length ? <ul>{c.evidence.map((e) => <li key={e.id} className="break-all">{e.filename} p.{e.page_number ?? '?'}</li>)}</ul> : '—'}
                    </td>
                    <td className="py-3 pr-4 text-ink-2">
                      {c?.explanation}
                      {c?.review_reason && <p className="mt-1"><strong className="text-ink">Review:</strong> {c.review_reason}</p>}
                      {!c?.explanation && !c?.review_reason && '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!list.length && <p className="mt-2 text-sm text-muted">No requirements yet.</p>}

        <h3 className="mt-10 text-[15px] font-semibold">Outstanding actions</h3>
        {ws.next_actions.length ? (
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-ink-2 marker:text-muted">
            {ws.next_actions.map((a, i) => <li key={i}><strong className="text-ink">{a.title}.</strong> {a.detail}</li>)}
          </ol>
        ) : <p className="mt-2 text-sm text-muted">None.</p>}
      </article>
    )}</Load>
  );
}
