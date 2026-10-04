// One application: header, tab navigation and the nested routes under /w/:id.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode } from 'react';
import type { WorkspaceDetail } from '../../../shared/schemas.ts';
import { api, refresh, useWorkspace } from '../api.ts';
import { fmtDate } from '../labels.ts';
import { Link, matchPath } from '../router.tsx';
import { DeadlineBadge, Icon, Load, NotFound, useTitle } from '../ui.tsx';
import { Activity } from './Activity.tsx';
import { Assistant } from './Assistant.tsx';
import { DocumentView } from './DocumentView.tsx';
import { Documents } from './Documents.tsx';
import { Overview } from './Overview.tsx';
import { Report } from './Report.tsx';
import { RequirementDetail } from './RequirementDetail.tsx';
import { Requirements } from './Requirements.tsx';
import { Tasks } from './Tasks.tsx';

// Tabs appear once they have something to show. Activity (workflow runs, for operators) is linked, not tabbed.
const TABS: [string, string, (ws: WorkspaceDetail) => boolean, (ws: WorkspaceDetail) => number | null][] = [
  ['', 'Overview', () => true, () => null],
  ['requirements', 'Requirements', () => true, (ws) => ws.counts.requirements || null],
  ['documents', 'Documents', () => true, (ws) => ws.counts.documents || null],
  ['tasks', 'Tasks', () => true, (ws) => ws.counts.open_tasks || null],
  ['assistant', 'Assistant', (ws) => ws.counts.documents > 0, () => null],
  ['report', 'Report', (ws) => ws.counts.requirements > 0, () => null],
];

type Page = (ws: WorkspaceDetail, p: Record<string, string>) => ReactNode;
const ROUTES: [string, Page][] = [
  ['', (ws) => <Overview ws={ws} />],
  ['requirements', (ws) => <Requirements ws={ws} />],
  ['requirements/:rid', (ws, p) => <RequirementDetail key={p.rid} ws={ws} rid={p.rid} />],
  ['documents', (ws) => <Documents ws={ws} />],
  ['documents/:did', (ws, p) => <DocumentView key={p.did} ws={ws} did={p.did} />],
  ['assistant', (ws) => <Assistant ws={ws} />],
  ['tasks', (ws) => <Tasks ws={ws} />],
  ['activity', (ws) => <Activity ws={ws} />],
  ['report', (ws) => <Report ws={ws} />],
];

function page(ws: WorkspaceDetail, rest: string): ReactNode {
  for (const [pattern, render] of ROUTES) {
    const params = matchPath(pattern, rest);
    if (params) return render(ws, params);
  }
  return <NotFound />;
}

export function Workspace({ id, rest }: { id: string; rest: string }) {
  const q = useWorkspace(id);
  useRefreshOnProgress(q.data);
  useFirstAnalysis(q.data);
  return <Load q={q}>{(ws) => <Shell ws={ws} rest={rest} />}</Load>;
}

/**
 * The workspace query polls while documents process or an analysis runs. When its
 * numbers move, everything else on screen is refetched, so lists catch up without polling too.
 */
function useRefreshOnProgress(ws: WorkspaceDetail | undefined) {
  const qc = useQueryClient();
  const beat = ws && JSON.stringify([ws.counts, ws.analysis?.id, ws.analysis?.status, ws.stale_analysis]);
  const last = useRef(beat);
  useEffect(() => {
    if (last.current && beat !== last.current) void refresh(qc);
    last.current = beat;
  }, [beat, qc]);
}

/**
 * The first analysis starts by itself as soon as it can (requirements confirmed, a document ready):
 * no one should have to find a button to see their first checklist. Re-runs stay a deliberate click.
 * The server refuses a second concurrent run (409), so another tab doing the same is harmless.
 */
function useFirstAnalysis(ws: WorkspaceDetail | undefined) {
  const qc = useQueryClient();
  const fired = useRef(false);
  const due = Boolean(ws && !ws.analysis && ws.next_actions.some((a) => a.kind === 'analyze'));
  useEffect(() => {
    if (!due || !ws || fired.current) return;
    fired.current = true;
    api(`/workspaces/${ws.id}/analyze`, { json: {} }).then(() => refresh(qc), () => undefined); // a refusal leaves the "Run the analysis" action in place
  }, [due, ws, qc]);
}

function Shell({ ws, rest }: { ws: WorkspaceDetail; rest: string }) {
  useTitle(ws.name);
  const base = `/w/${ws.id}`;
  return (
    <>
      <header className="print:hidden">
        <Link to="/dashboard" className="inline-flex items-center gap-1.5 text-sm font-medium text-white/75 transition-colors hover:text-white">
          <Icon name="back" className="h-3.5 w-3.5" />Applications
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="sky-shadow break-words font-display text-4xl font-medium leading-tight text-white sm:text-5xl">{ws.name}</h1>
            {ws.institution && <p className="mt-1.5 text-[15px] text-white/80">{ws.institution}</p>}
          </div>
          {ws.deadline && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-white/80">Deadline <span className="font-semibold text-white">{fmtDate(ws.deadline)}</span></span>
              <DeadlineBadge day={ws.deadline} sky />
            </div>
          )}
        </div>
        <nav aria-label="Application sections" className="-mx-4 mt-7 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <ul className="flex w-max gap-1 rounded-full bg-white/10 p-1 ring-1 ring-inset ring-white/20 backdrop-blur-sm">
            {TABS.filter(([, , show]) => show(ws)).map(([path, text, , count]) => {
              const current = path ? rest === path || rest.startsWith(`${path}/`) : rest === '';
              const n = count(ws);
              return (
                <li key={path} className="shrink-0">
                  <Link to={path ? `${base}/${path}` : base} aria-current={current ? 'page' : undefined}
                    className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium text-white/75 transition hover:bg-white/10 hover:text-white aria-[current=page]:bg-white aria-[current=page]:text-accent aria-[current=page]:shadow-pill sm:px-4">
                    {text}
                    {n !== null && <span className="hidden rounded-full bg-current/15 px-1.5 text-[11px] font-bold tabular-nums sm:inline">{n}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      <div className="mt-8">{page(ws, rest)}</div>
    </>
  );
}
