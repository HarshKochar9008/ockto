// Signed-in home, laid out as a bento dashboard. No applications yet: start the first one right here.
// Otherwise: a hero (greeting, search, headline numbers, "start a new one"), then the applications, what's coming up,
// overall readiness, checklist status, the next deadline, recent activity and evidence coverage.
// Every number comes from /dashboard; nothing here is decorative data.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Counts, DashboardDto, WorkspaceDetail, WorkspaceSummary } from '../../../shared/schemas.ts';
import { POLL_MS, api, isProcessing, useMe } from '../api.ts';
import { ACTORS, EVENTS, daysUntil, fmtDate, fmtDateTime, label, plural } from '../labels.ts';
import { Link, navigate, useLocation } from '../router.tsx';
import {
  Badge, Button, Card, DeadlineBadge, ErrorText, Icon, Input, Load, Modal, Spinner, StatusBar, buttonClass, formValues, useTitle, type IconName,
} from '../ui.tsx';

export function Dashboard() {
  const q = useQuery({
    queryKey: ['dashboard'], queryFn: () => api<DashboardDto>('/dashboard'),
    refetchInterval: (q) => (q.state.data?.processing.some(isProcessing) ? POLL_MS : false),
  });
  return <Load q={q}>{(d) => (d.workspaces.length ? <Home d={d} /> : <FirstRun />)}</Load>;
}

// ------------------------------------------------------------------ first run

const JOURNEY = [['Requirements', 'Upload the programme’s rules'], ['Your documents', 'Transcript, passport, CV…'], ['Your checklist', 'Every item with its evidence']];

function FirstRun() {
  useTitle('Start your first application');
  return (
    <div className="animate-in mx-auto max-w-xl pt-2 text-center sm:pt-8">
      <p className="text-xs font-bold uppercase tracking-[0.25em] text-white/70">Welcome to PaperTrail</p>
      <h1 className="sky-shadow mt-3 font-display text-4xl font-medium leading-tight text-white sm:text-5xl">
        Start your first <em className="italic">application.</em>
      </h1>
      <p className="mt-3 text-[15px] text-white/85">Name it and add the deadline. Next you’ll add the programme’s requirements.</p>
      <Card emphasis className="mt-8 text-left"><NewWorkspace /></Card>
      <ol className="mt-10 grid gap-4 text-left sm:grid-cols-3 sm:text-center">
        {JOURNEY.map(([title, text], i) => (
          <li key={title} className="flex gap-3 sm:flex-col sm:items-center sm:gap-0">
            <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[13px] font-bold ${i === 0 ? 'bg-white text-accent shadow-pill' : 'bg-white/20 text-white ring-1 ring-inset ring-white/40'}`}>{i + 1}</span>
            <div className="sm:mt-3">
              <p className="text-sm font-semibold text-white">{title}</p>
              <p className="text-xs text-white/75">{text}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ----------------------------------------------------------------------- home

const sum = (ws: WorkspaceSummary[], k: keyof Counts) => ws.reduce((n, w) => n + w.counts[k], 0);
const pct = (n: number, of: number) => (of ? n / of : 0);
/** 'YYYY-MM-DD' is a calendar day (local midnight); anything else is an instant. */
const toDay = (s: string) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00` : s);
const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });

function Home({ d }: { d: DashboardDto }) {
  useTitle('Your applications');
  const { query } = useLocation();
  const [search, setSearch] = useState('');
  const ws = d.workspaces;
  const t = {
    requirements: sum(ws, 'requirements'), verified: sum(ws, 'satisfied_verified'), satisfied: sum(ws, 'satisfied'),
    open_tasks: sum(ws, 'open_tasks'),
  };
  return (
    <div className="space-y-6">
      <Hero d={d} totals={t} search={search} onSearch={setSearch} />
      {/* The modal follows the URL, so the rail's "New application" opens it from anywhere. */}
      <Modal open={query.get('new') === '1'} onClose={() => navigate('/dashboard', { replace: true })} title="New application"><NewWorkspace /></Modal>
      {/* Two columns, so a long "Upcoming" list never stretches the cards beside it. */}
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="grid content-start gap-6 lg:col-span-8 lg:grid-cols-8">
          <Applications ws={ws} search={search} className="lg:col-span-8" />
          <Readiness verified={t.verified} of={t.requirements} className="lg:col-span-3" />
          <StatusChart ws={ws} className="lg:col-span-5" />
        </div>
        <Upcoming d={d} className="lg:col-span-4" />
        <DaysLeft ws={ws} className="lg:col-span-4" />
        <Activity d={d} className="lg:col-span-4" />
        <Coverage found={t.satisfied} of={t.requirements} className="lg:col-span-4" />
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------- hero

function Hero({ d, totals, search, onSearch }: {
  d: DashboardDto; totals: { requirements: number; verified: number; open_tasks: number }; search: string; onSearch: (s: string) => void;
}) {
  const me = useMe();
  const input = useRef<HTMLInputElement>(null);
  // ⌘K / Ctrl+K jumps to the search, as the hint on the field says.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = me.data?.name.split(/\s+/)[0];
  const latest = d.workspaces[0]; // most recently updated first
  const mac = /Mac|iP(hone|ad)/.test(navigator.platform);

  return (
    <section aria-labelledby="hero-title"
      className="animate-in relative isolate overflow-hidden rounded-[2rem] p-5 shadow-lift ring-1 ring-inset ring-white/25 sm:p-7 lg:p-8"
      style={{ background: 'linear-gradient(135deg, #3c4ed2 0%, #5f6ae4 38%, #9a86e6 72%, #dda3d6 100%)' }}>
      <div aria-hidden="true" className="section-stars -z-10" />
      <span aria-hidden="true" className="shooting-star -z-10" style={{ top: '14%', right: '8%' }} />
      <HeroArt />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-white/75">{greeting}{name ? `, ${name}` : ''}</p>
          <h1 id="hero-title" className="sky-shadow mt-2 font-display text-4xl font-medium leading-tight text-white sm:text-5xl">
            Your <em className="italic">applications.</em>
          </h1>
        </div>
        <label className="flex h-12 w-full items-center gap-2.5 rounded-full bg-white/90 px-4 text-ink shadow-pill backdrop-blur-sm transition focus-within:ring-4 focus-within:ring-white/50 sm:w-80">
          <Icon name="search" className="h-4 w-4 text-muted" />
          <span className="sr-only">Search applications</span>
          <input ref={input} type="search" value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search applications"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" />
          <kbd className="hidden rounded-md bg-sunken px-1.5 py-0.5 font-sans text-[11px] font-semibold text-muted sm:inline">{mac ? '⌘' : 'Ctrl'} K</kbd>
        </label>
      </div>

      <div className="mt-12 grid grid-cols-3 gap-2.5 sm:gap-3 lg:mt-20 lg:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.35fr)]">
        <StatTile icon="layers" label="Applications" value={d.workspaces.length} href="#applications" />
        <StatTile icon="check" label="Verified" value={totals.verified} of={totals.requirements} href="#status" />
        <StatTile icon="clock" label="Open tasks" value={totals.open_tasks} href="#upcoming" />
        <div className="col-span-3 flex flex-col justify-between rounded-3xl bg-pop p-5 text-pop-ink shadow-[0_18px_40px_-18px_rgba(54,69,8,0.55)] lg:col-span-1">
          <div>
            <p className="font-display text-xl font-semibold">Start a new application</p>
            <p className="mt-1 text-sm opacity-80">Add the programme’s requirements and PaperTrail drafts the checklist.</p>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to="/dashboard?new=1" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white px-4 text-[13px] font-semibold text-pop-ink shadow-soft transition hover:bg-white/80">
              <Icon name="plus" className="h-3.5 w-3.5" />New application
            </Link>
            {latest && (
              <Link to={`/w/${latest.id}/documents`} title={`Add documents to ${latest.name}`}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white/60 px-4 text-[13px] font-semibold text-pop-ink transition hover:bg-white">
                <Icon name="upload" className="h-3.5 w-3.5" />Add documents<span className="sr-only"> to {latest.name}</span>
              </Link>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** A headline number in a frosted tile; the whole tile jumps to its card below. */
function StatTile({ icon, label: text, value, of, href }: { icon: IconName; label: string; value: number; of?: number; href: string }) {
  return (
    <a href={href} className="group relative flex min-h-32 flex-col justify-between rounded-3xl bg-white/70 p-3.5 text-ink shadow-soft ring-1 ring-inset ring-white/60 backdrop-blur-md transition hover:bg-white/85 sm:p-4">
      <span className="flex items-center gap-2 text-xs font-semibold text-ink-2 sm:text-sm">
        <span className="hidden h-7 w-7 place-items-center rounded-full bg-white text-accent shadow-soft sm:grid"><Icon name={icon} className="h-3.5 w-3.5" /></span>
        {text}
      </span>
      <span className="mt-4 flex items-baseline gap-1">
        <span className="font-display text-3xl font-medium tabular-nums sm:text-4xl">{value}</span>
        {of !== undefined && <span className="text-xs text-muted sm:text-sm">/ {of}</span>}
      </span>
      <span aria-hidden="true" className="absolute bottom-3.5 right-3.5 hidden h-9 w-9 place-items-center rounded-full bg-white text-ink shadow-soft transition group-hover:bg-accent-solid group-hover:text-white sm:grid">
        <Icon name="arrowUpRight" />
      </span>
    </a>
  );
}

/** Translucent ribbons sweeping up to the right, where the reference has its curved architecture. */
const HeroArt = () => (
  <svg aria-hidden="true" viewBox="0 0 640 360" preserveAspectRatio="xMaxYMid slice" className="pointer-events-none absolute inset-y-0 right-0 -z-10 h-full w-[78%]">
    <defs>
      <linearGradient id="pt-ribbon" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stopColor="#fff" stopOpacity="0" />
        <stop offset=".55" stopColor="#fff" stopOpacity=".32" />
        <stop offset="1" stopColor="#fff" stopOpacity=".06" />
      </linearGradient>
    </defs>
    {[0, 1, 2, 3, 4, 5].map((i) => (
      <path key={i} d={`M${60 + i * 46} 400 C ${230 + i * 34} ${270 - i * 22}, ${330 + i * 22} ${130 - i * 12}, 700 ${30 + i * 34}`}
        fill="none" stroke="url(#pt-ribbon)" strokeWidth={54 - i * 7} strokeLinecap="round" />
    ))}
  </svg>
);

// --------------------------------------------------------------- applications

// Same language as the checklist: AI-found evidence and user-verified items are different states.
const segments = (c: Counts) => [
  { label: 'Verified', count: c.satisfied_verified, color: 'bg-ok-dot' },
  { label: 'Evidence found (AI)', count: c.satisfied - c.satisfied_verified, color: 'bg-ok-light' },
  { label: 'Needs review', count: c.needs_review, color: 'bg-warn-dot' },
  { label: 'Missing', count: c.missing, color: 'bg-bad-dot' },
  { label: 'Expired', count: c.expired, color: 'bg-crit-dot' },
  { label: 'Not applicable', count: c.not_applicable, color: 'bg-na-dot' },
  { label: 'Not assessed', count: c.pending, color: 'bg-line-strong' },
];

function Applications({ ws, search, className }: { ws: WorkspaceSummary[]; search: string; className: string }) {
  const term = search.trim().toLowerCase();
  const shown = term ? ws.filter((w) => `${w.name} ${w.institution ?? ''}`.toLowerCase().includes(term)) : ws;
  return (
    <div id="applications" className={`scroll-mt-24 ${className}`}>
      <Card title="Your applications" description={plural(ws.length, 'application')}
        actions={<Link to="/dashboard?new=1" className={buttonClass('secondary', 'sm')}><Icon name="plus" className="h-3.5 w-3.5" />New</Link>}>
        {shown.length ? (
          <ul className="-mx-2 space-y-1">
            {shown.map((w) => <li key={w.id}><ApplicationRow w={w} /></li>)}
          </ul>
        ) : <p className="py-6 text-center text-sm text-muted">No applications match “{search}”.</p>}
      </Card>
    </div>
  );
}

function ApplicationRow({ w }: { w: WorkspaceSummary }) {
  const c = w.counts;
  const flags = [[c.expired, 'expired', 'red'], [c.missing, 'missing', 'rose'], [c.needs_review, 'to review', 'amber']] as const;
  return (
    <Link to={`/w/${w.id}`} className="group flex items-center gap-4 rounded-2xl p-3 transition hover:bg-white hover:shadow-soft">
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-accent-line bg-accent-soft font-display text-xl font-semibold text-accent-ink">
        {w.name.trim().charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="truncate font-semibold text-ink group-hover:text-accent">{w.name}</span>
          {flags.map(([n, text, tone]) => n > 0 && <Badge key={text} tone={tone}>{n} {text}</Badge>)}
          {c.processing > 0 && <Badge tone="accent"><Spinner className="h-3 w-3" />{c.processing} reading</Badge>}
          {c.failed_documents > 0 && <Badge tone="red">{c.failed_documents} failed</Badge>}
        </span>
        {w.institution && <span className="block truncate text-xs text-muted">{w.institution}</span>}
        <span className="mt-2 flex items-center gap-3">
          <span className="flex-1"><StatusBar segments={segments(c)} legend={false} /></span>
          <span className="text-xs tabular-nums text-ink-2">{c.satisfied_verified}/{c.requirements} verified</span>
        </span>
      </span>
      <span className="hidden shrink-0 sm:block">{w.deadline && <DeadlineBadge day={w.deadline} />}</span>
      <Icon name="arrow" className="h-4 w-4 shrink-0 text-faint transition group-hover:translate-x-0.5 group-hover:text-accent" />
    </Link>
  );
}

// ------------------------------------------------------------------- upcoming

type UpcomingItem = { key: string; when: string; title: string; sub: string; to: string };

function Upcoming({ d, className }: { d: DashboardDto; className: string }) {
  const [all, setAll] = useState(false);
  const items: UpcomingItem[] = [
    ...d.workspaces.filter((w) => w.deadline).map((w) => ({
      key: `w:${w.id}`, when: w.deadline!, title: `${w.name} deadline`, sub: w.institution ?? 'Application deadline', to: `/w/${w.id}`,
    })),
    ...d.upcoming.filter((t) => t.due_at).map((t) => ({
      key: `t:${t.id}`, when: t.due_at!, title: t.title, sub: t.workspace_name ?? 'Task', to: `/w/${t.workspace_id}/tasks`,
    })),
  ].sort((a, b) => toDay(a.when).getTime() - toDay(b.when).getTime());
  const shown = all ? items : items.slice(0, 5);
  return (
    <div id="upcoming" className={`scroll-mt-24 ${className}`}>
      <Card className="h-full" title="Upcoming"
        actions={items.length > 5 && (
          <button type="button" onClick={() => setAll(!all)} className="rounded-full bg-night px-4 py-2 text-xs font-semibold text-white transition hover:bg-accent-solid">
            {all ? 'Show less' : 'View all'}
          </button>
        )}>
        {shown.length ? (
          <ul className="space-y-2.5">
            {shown.map((i) => {
              const late = toDay(i.when).getTime() < Date.now();
              return (
                <li key={i.key}>
                  <Link to={i.to} className="group flex items-start gap-3 rounded-2xl border border-line bg-surface p-3.5 transition hover:border-accent-line hover:shadow-soft">
                    <span className="min-w-0 flex-1">
                      <span className={`block text-[11px] font-medium ${late ? 'text-crit-ink' : 'text-muted'}`}>{longDay.format(toDay(i.when))}{late && ' · overdue'}</span>
                      <span className="mt-0.5 block font-semibold leading-snug text-ink">{i.title}</span>
                      <span className="block truncate text-xs text-muted">{i.sub}</span>
                    </span>
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-sunken text-muted transition group-hover:bg-accent-solid group-hover:text-white">
                      <Icon name="arrowUpRight" className="h-3.5 w-3.5" />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : <p className="text-sm text-muted">Nothing scheduled. Add a deadline to an application, or a due date to a task.</p>}
      </Card>
    </div>
  );
}

// ------------------------------------------------------ readiness & coverage

function Readiness({ verified, of, className }: { verified: number; of: number; className: string }) {
  const v = pct(verified, of);
  const r = 56, circ = 2 * Math.PI * r;
  return (
    <Card className={className} title="Readiness" description="Verified by you, across all applications.">
      <div className="flex flex-col items-center">
        <svg viewBox="0 0 160 160" className="h-40 w-40" role="img" aria-label={`${Math.round(v * 100)}% verified`}>
          <circle cx="80" cy="80" r="74" fill="none" className="stroke-line-strong" strokeWidth="2" strokeDasharray="1.5 6" strokeLinecap="round" />
          <circle cx="80" cy="80" r={r} fill="none" className="stroke-sunken" strokeWidth="14" />
          {v > 0 && <circle cx="80" cy="80" r={r} fill="none" className="stroke-accent-solid" strokeWidth="14" strokeLinecap="round"
            strokeDasharray={`${circ * v} ${circ}`} transform="rotate(-90 80 80)" />}
          <text x="80" y="90" textAnchor="middle" className="fill-ink font-display text-[30px]">{Math.round(v * 100)}%</text>
        </svg>
        <p className="mt-2 text-center text-sm text-ink-2">{of ? <>{verified} of {plural(of, 'requirement')}</> : 'No requirements yet'}</p>
      </div>
    </Card>
  );
}

function Coverage({ found, of, className }: { found: number; of: number; className: string }) {
  const v = pct(found, of);
  const ticks = 31;
  return (
    <Card className={className} title="Evidence coverage" actions={<Chip>All applications</Chip>}>
      <svg viewBox="0 0 200 112" className="mx-auto w-full max-w-[240px]" role="img" aria-label={`${Math.round(v * 100)}% of requirements have a matching passage`}>
        {Array.from({ length: ticks }, (_, i) => {
          const a = Math.PI * (1 - i / (ticks - 1));
          const on = v > 0 && i / (ticks - 1) <= v;
          return <line key={i} x1={100 + 66 * Math.cos(a)} y1={104 - 66 * Math.sin(a)} x2={100 + 90 * Math.cos(a)} y2={104 - 90 * Math.sin(a)}
            strokeWidth="4.5" strokeLinecap="round" className={on ? 'stroke-ok-dot' : 'stroke-sunken'} />;
        })}
        <text x="100" y="100" textAnchor="middle" className="fill-ink font-display text-[30px]">{Math.round(v * 100)}%</text>
      </svg>
      <p className="mt-2 text-center text-sm text-ink-2">of requirements have a matching passage. Verify them to count them as done.</p>
    </Card>
  );
}

const Chip = ({ children }: { children: ReactNode }) => (
  <span className="rounded-full bg-sunken px-3 py-1 text-[11px] font-semibold text-ink-2">{children}</span>
);

// --------------------------------------------------------------- status chart

const BARS: [string, (c: (k: keyof Counts) => number) => number, string][] = [
  ['Verified', (n) => n('satisfied_verified'), '--color-ok-dot'],
  ['AI found', (n) => n('satisfied') - n('satisfied_verified'), '--color-ok-light'],
  ['Review', (n) => n('needs_review'), '--color-warn-dot'],
  ['Missing', (n) => n('missing'), '--color-bad-dot'],
  ['Expired', (n) => n('expired'), '--color-crit-dot'],
  ['Pending', (n) => n('pending'), '--color-na-dot'],
];

function StatusChart({ ws, className }: { ws: WorkspaceSummary[]; className: string }) {
  const bars = BARS.map(([text, count, color]) => ({ text, color, n: count((k) => sum(ws, k)) }));
  const max = Math.max(1, ...bars.map((b) => b.n));
  const top = bars.reduce((a, b) => (b.n > a.n ? b : a));
  // The tallest bar is hatched, as in the reference: it's where most of the work is.
  const fill = (color: string, hatch: boolean): CSSProperties => (hatch
    ? { background: `repeating-linear-gradient(135deg, var(${color}) 0 4px, color-mix(in oklab, var(${color}) 40%, transparent) 4px 9px)` }
    : { background: `color-mix(in oklab, var(${color}) 50%, transparent)` });
  return (
    <div id="status" className={`scroll-mt-24 ${className}`}>
      <Card className="h-full" title="Checklist status" actions={<Chip>All applications</Chip>}>
        {/* One plot area: gridlines and bars share the same top and baseline. Labels sit in the 1.5rem below it. */}
        <div className="flex h-56 gap-2 pt-6">
          <div aria-hidden="true" className="flex w-5 flex-col justify-between pb-6 text-right text-[10px] leading-none tabular-nums text-faint">
            <span>{max}</span><span /><span>0</span>
          </div>
          <div className="relative flex-1">
            <div aria-hidden="true" className="absolute inset-x-0 bottom-6 top-0 flex flex-col justify-between">
              {[0, 1, 2].map((i) => <span key={i} className="h-px bg-line" />)}
            </div>
            <ul className="absolute inset-0 flex justify-around">
              {bars.map((b) => (
                <li key={b.text} className="flex h-full flex-col items-center" role="img" aria-label={`${b.text}: ${b.n}`}>
                  <span className="flex h-[calc(100%-1.5rem)] items-end">
                    <span className="relative w-6 rounded-full sm:w-8" style={{ height: `${(b.n / max) * 100}%`, minHeight: '6px', ...fill(b.color, b === top && b.n > 0) }}>
                      <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[11px] font-semibold tabular-nums text-ink-2">{b.n}</span>
                    </span>
                  </span>
                  <span className="h-6 pt-1.5 text-[10px] font-medium text-muted sm:text-[11px]">{b.text}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------ next deadline

function DaysLeft({ ws, className }: { ws: WorkspaceSummary[]; className: string }) {
  const next = ws.filter((w) => w.deadline && daysUntil(w.deadline) >= 0)
    .sort((a, b) => daysUntil(a.deadline!) - daysUntil(b.deadline!))[0];
  if (!next) {
    return (
      <Card className={className} title="Next deadline">
        <p className="text-sm text-ink-2">No upcoming deadline. Add one to an application and it counts down here.</p>
      </Card>
    );
  }
  const n = daysUntil(next.deadline!);
  const c = next.counts;
  return (
    <Card className={className}>
      <p className="font-display text-4xl font-semibold leading-tight">
        {n === 0 ? 'Due' : n} <em className="font-medium italic">{n === 0 ? 'today' : n === 1 ? 'day left' : 'days left'}</em>
      </p>
      <p className="mt-3 text-sm leading-relaxed text-ink-2">
        until <strong className="font-semibold text-ink">{next.name}</strong> is due on {fmtDate(next.deadline)}.
        {c.requirements > 0 && <> {c.satisfied_verified} of {plural(c.requirements, 'requirement')} verified so far.</>}
      </p>
      <Link to={`/w/${next.id}`} className={`${buttonClass('primary', 'sm')} mt-5`}>Open application<Icon name="arrow" className="h-3.5 w-3.5" /></Link>
    </Card>
  );
}

// ------------------------------------------------------------------ activity

const FILTERS = [['all', 'All'], ['user', 'You'], ['ai', 'AI']] as const;

function Activity({ d, className }: { d: DashboardDto; className: string }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all');
  const rows = d.activity.filter((a) => filter === 'all' || a.actor_type === filter).slice(0, 5);
  return (
    <section aria-labelledby="activity-title" className={`rounded-3xl bg-night p-5 text-white shadow-lift sm:p-6 ${className}`}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2 id="activity-title" className="font-display text-lg font-semibold">Recent activity</h2>
        <div role="group" aria-label="Show activity by" className="flex gap-1 rounded-full bg-white/10 p-1 text-[11px]">
          {FILTERS.map(([k, text]) => (
            <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}
              className="rounded-full px-3 py-1 font-semibold text-white/70 transition hover:text-white aria-pressed:bg-pop aria-pressed:text-pop-ink">
              {text}
            </button>
          ))}
        </div>
      </div>
      {rows.length ? (
        <ul className="space-y-3.5">
          {rows.map((a) => (
            <li key={a.id}>
              <Link to={`/w/${a.workspace_id}/activity`} className="group flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/15 text-[11px] font-bold">
                  {a.actor_type === 'ai' ? 'AI' : a.actor_type === 'user' ? 'Y' : 'S'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm"><span className="font-semibold">{label(ACTORS, a.actor_type)}</span> <span className="text-white/80">{label(EVENTS, a.event_type)}</span></span>
                  <span className="block text-xs text-white/55">{a.workspace_name} · {fmtDateTime(a.created_at)}</span>
                </span>
                <Icon name="arrowUpRight" className="mt-1 h-3.5 w-3.5 text-white/40 transition group-hover:text-white" />
              </Link>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-white/60">Nothing here yet.</p>}
    </section>
  );
}

// ------------------------------------------------------------- new application

/** Name, school, deadline. Then straight to the requirements: that is the first real step. */
function NewWorkspace() {
  const create = useMutation({
    mutationFn: (body: Record<string, string | null>) => api<WorkspaceDetail>('/workspaces', { json: body }),
    onSuccess: (ws) => navigate(`/w/${ws.id}/requirements`),
  });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(formValues(e.currentTarget)); }}>
      <Input label="Application name" name="name" required maxLength={120} placeholder="MSc Data Science 2027" autoFocus />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Institution (optional)" name="institution" maxLength={200} placeholder="Northbridge University" />
        <Input label="Deadline (optional)" name="deadline" type="date" hint="We flag documents that expire before it." />
      </div>
      <ErrorText error={create.error} />
      <Button type="submit" variant="primary" size="lg" className="w-full" busy={create.isPending}>
        Create and add requirements<Icon name="arrow" />
      </Button>
    </form>
  );
}
