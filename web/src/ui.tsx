// Accessible building blocks in the Flywheel design language: white type on the sky, warm paper cards,
// pill buttons, Fraunces headings. Tailwind + the theme tokens in index.css.
import type { UseQueryResult } from '@tanstack/react-query';
import {
  useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import type { ChecklistDto, DocumentDto, RunDto } from '../../shared/schemas.ts';
import { ApiError, useSystem } from './api.ts';
import { ACTIVITIES, GROUPS, RUN_STATUSES, countdown, daysUntil, fmtDate, groupOf, label, today, type Group } from './labels.ts';
import { Link } from './router.tsx';

// ---------------------------------------------------------------------- icons

const ICONS = {
  upload: 'M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3.5',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  back: 'M19 12H5m5 5-5-5 5-5',
  clock: 'M12 7.5V12l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  shield: 'M12 3 5 6v5.2c0 4.3 2.9 8.2 7 9.8 4.1-1.6 7-5.5 7-9.8V6zm-3 9 2.2 2.2L15.5 10',
  sparkle: 'M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.5l-1.9-5.7-5.6-1.9L10.1 9zM19 3v3m1.5-1.5h-3',
  search: 'M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9.5 3-4.5-4.5',
  plus: 'M12 5v14M5 12h14',
  chevron: 'm9 6 6 6-6 6',
  calendar: 'M8 3v3m8-3v3M4 10h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  chat: 'M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.3-4.6A7.5 7.5 0 1 1 20 11.5z',
  list: 'M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01',
  x: 'M6 6l12 12M18 6 6 18',
  alert: 'M12 9v4m0 3.5h.01M10.3 4 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z',
  history: 'M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v4h4M12 8v4l2.5 2',
  quote: 'M7 7h4v4c0 3-1.5 5-4 6M15 7h4v4c0 3-1.5 5-4 6',
  flag: 'M5 21V4m0 0h11l-2 4 2 4H5',
  bolt: 'M13 3 5 13.5h6L10 21l8-10.5h-6z',
  trash: 'M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  home: 'M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z',
  sliders: 'M4 7h9m4 0h3M4 17h3m4 0h9M15 5v4M9 15v4',
  arrowUpRight: 'M7 17 17 7M8.5 7H17v8.5',
  layers: 'M12 3.5 3 8.5l9 5 9-5zM3 13.5l9 5 9-5',
  eye: 'M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6zm9.5-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff: 'm3 3 18 18M10.6 6.2A10.8 10.8 0 0 1 12 6c6.1 0 9.5 6 9.5 6a16 16 0 0 1-2.4 3.1M6.2 6.2C3.8 7.8 2.5 12 2.5 12s3.4 6 9.5 6a10 10 0 0 0 3-.5M9.9 9.9a3 3 0 0 0 4.2 4.2',
} as const;
export type IconName = keyof typeof ICONS;

export const Icon = ({ name, className = 'h-4 w-4' }: { name: IconName; className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
    className={`shrink-0 ${className}`} aria-hidden="true">
    <path d={ICONS[name]} />
  </svg>
);

/** The indigo icon chip that heads a card. */
export const IconTile = ({ name, size = 'md' }: { name: IconName; size?: 'sm' | 'md' }) => (
  <span className={`grid shrink-0 place-items-center border border-accent-line bg-accent-soft text-accent-ink ${size === 'sm' ? 'h-9 w-9 rounded-xl' : 'h-11 w-11 rounded-2xl'}`}>
    <Icon name={name} className={size === 'sm' ? 'h-4 w-4' : 'h-[18px] w-[18px]'} />
  </span>
);

// -------------------------------------------------------------------- buttons

// primary/secondary/ghost/danger sit on paper; light (white pill) and glass sit on the sky.
const VARIANTS = {
  primary: 'border-transparent bg-accent-solid text-white shadow-press hover:bg-accent-solid-hover',
  secondary: 'border-line-strong bg-surface text-ink-2 hover:border-accent-solid/60 hover:text-accent',
  danger: 'border-crit-line bg-surface text-crit-ink hover:bg-crit-soft',
  ghost: 'border-transparent bg-transparent text-ink-2 hover:bg-sunken hover:text-ink',
  light: 'border-transparent bg-white text-accent shadow-pill hover:bg-accent-soft',
  glass: 'border-white/50 bg-white/10 text-white backdrop-blur-sm hover:bg-white/20',
};
type Variant = keyof typeof VARIANTS;
type Size = 'sm' | 'md' | 'lg';
const SIZES: Record<Size, string> = { sm: 'h-8 px-3 text-[13px]', md: 'h-10 px-4 text-sm', lg: 'h-12 px-7 text-sm' };

export const buttonClass = (variant: Variant = 'secondary', size: Size = 'md') =>
  `inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-full border font-semibold transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 ${SIZES[size]} ${VARIANTS[variant]}`;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; busy?: boolean };
export function Button({ variant, size, busy, disabled, className = '', type = 'button', children, ...rest }: ButtonProps) {
  return (
    <button type={type} className={`${buttonClass(variant, size)} ${className}`} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy && <Spinner />}
      {children}
    </button>
  );
}

/** Two steps, in the page. Never window.confirm. */
export function ConfirmDelete({ prompt, onConfirm, busy }: { prompt: string; onConfirm: () => void; busy?: boolean }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <Button size="sm" variant="ghost" onClick={() => setAsking(true)}>Delete</Button>;
  return (
    <span role="group" aria-label="Confirm delete" className="inline-flex flex-wrap items-center gap-2 rounded-2xl bg-crit-soft px-2.5 py-1.5">
      <span className="text-xs text-crit-ink">{prompt}</span>
      <Button size="sm" variant="danger" busy={busy} onClick={onConfirm} autoFocus>Yes, delete</Button>
      <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
    </span>
  );
}

// ---------------------------------------------------------- layout & states

/** A paper card. `emphasis` marks the one card on a page that holds the next step: it glows against the sky. */
export function Card({ title, description, actions, emphasis, className = '', children }: {
  title?: ReactNode; description?: ReactNode; actions?: ReactNode; emphasis?: boolean; className?: string; children: ReactNode;
}) {
  return (
    <section className={`card rounded-3xl p-5 sm:p-6 ${emphasis ? 'shadow-lift ring-4 ring-white/45' : ''} ${className}`}>
      {(title || actions) && (
        <div className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            {title && <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-1 text-sm leading-relaxed text-ink-2">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export const useTitle = (title: string) => useEffect(() => { document.title = `${title} · PaperTrail`; }, [title]);

/** Eyebrow, then a Fraunces heading with its last words in italic ("Your *applications.*"), on the sky. */
export function PageHeader({ title, em, eyebrow, description, actions }: {
  title: string; em?: string; eyebrow?: ReactNode; description?: ReactNode; actions?: ReactNode;
}) {
  useTitle(em ? `${title} ${em}`.replace(/[.]$/, '') : title);
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <p className="mb-2 text-xs font-bold uppercase tracking-[0.25em] text-white/70">{eyebrow}</p>}
        <h1 className="sky-shadow font-display text-4xl font-medium leading-tight text-white sm:text-[2.75rem]">
          {title}{em && <> <em className="italic">{em}</em></>}
        </h1>
        {description && <p className="mt-2 max-w-2xl text-[15px] text-white/80">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

const NOTICE = {
  info: 'border-accent-line bg-accent-soft text-accent-ink',
  warn: 'border-warn-line bg-warn-soft text-warn-ink',
  error: 'border-crit-line bg-crit-soft text-crit-ink',
};
export const Notice = ({ tone = 'info', className = '', children }: { tone?: keyof typeof NOTICE; className?: string; children: ReactNode }) => (
  <div className={`rounded-2xl border px-4 py-3 text-sm ${NOTICE[tone]} ${className}`}>{children}</div>
);

/** Inherits the colour around it: white on the sky, ink on paper. */
export const Spinner = ({ label: text, className = 'h-4 w-4' }: { label?: string; className?: string }) => (
  <span className="inline-flex items-center gap-2" role={text ? 'status' : undefined}>
    <svg className={`${className} shrink-0 animate-spin`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
    {text && <span className="text-sm opacity-80">{text}</span>}
  </span>
);

/** `sky`: a dashed slot drawn straight on the sky (Flywheel's "declare your first…" tile); otherwise a slot inside a card. */
export const EmptyState = ({ title, icon, action, sky, children }: { title: string; icon?: IconName; action?: ReactNode; sky?: boolean; children?: ReactNode }) => (
  <div className={`rounded-3xl border-2 border-dashed px-6 py-12 text-center ${sky ? 'border-white/50 bg-white/10 text-white' : 'border-line-strong bg-surface-2/70 text-ink'}`}>
    {icon && (
      <span className={`mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl ${sky ? 'bg-white/15 text-white' : 'border border-accent-line bg-accent-soft text-accent-ink'}`}>
        <Icon name={icon} className="h-5 w-5" />
      </span>
    )}
    <p className="font-display text-lg font-medium">{title}</p>
    {children && <p className={`mx-auto mt-1.5 max-w-md text-sm leading-relaxed ${sky ? 'text-white/80' : 'text-ink-2'}`}>{children}</p>}
    {action && <div className="mt-6">{action}</div>}
  </div>
);

export const ErrorState = ({ error, onRetry }: { error: unknown; onRetry?: () => void }) => (
  <div role="alert" className="rounded-2xl border border-crit-line bg-crit-soft p-4 text-sm text-crit-ink">
    <p className="font-semibold">Something went wrong</p>
    <p className="mt-1">{error instanceof Error ? error.message : String(error)}</p>
    {onRetry && <Button className="mt-3" size="sm" onClick={onRetry}>Try again</Button>}
  </div>
);

/** A failed write: the server's message plus any per-field issues. */
export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const issues = error instanceof ApiError ? error.issues : [];
  return (
    <div role="alert" className="mt-2 rounded-xl bg-crit-soft px-3 py-2 text-sm text-crit-ink">
      {error instanceof Error ? error.message : String(error)}
      {issues.length > 0 && (
        <ul className="mt-1 list-disc pl-5">{issues.map((i) => <li key={i.path + i.message}>{i.path && `${i.path}: `}{i.message}</li>)}</ul>
      )}
    </div>
  );
}

/** Loading / error-with-retry / content, for one query. */
export function Load<T>({ q, children }: { q: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (q.isPending) return <div className="grid place-items-center py-12"><Spinner label="Loading…" /></div>;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return <>{children(q.data)}</>;
}

export const NotFound = () => (
  <EmptyState sky title="Page not found" icon="search" action={<Link to="/dashboard" className={buttonClass('light')}>Back to your applications</Link>}>
    That address does not match anything in PaperTrail.
  </EmptyState>
);

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (open && !d?.open) d?.showModal(); // native modal: focus trap, Esc, inert background
    if (!open && d?.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby={titleId}
      className="card relative m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-lg overflow-auto rounded-3xl p-0 shadow-pop backdrop:bg-[#1e1b4b]/40 backdrop:backdrop-blur-sm">
      <h2 id={titleId} className="border-b border-line py-5 pl-6 pr-14 font-display text-xl font-semibold">{title}</h2>
      <div className="p-6">{open && children}</div>
      {/* Last in the DOM: showModal() focuses the first focusable element, which should be the form, not "close". */}
      <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close" className="absolute right-4 top-4 w-8 px-0"><Icon name="x" /></Button>
    </dialog>
  );
}

export function Segmented<T extends string>({ label: name, options, value, onChange, className = '' }: {
  label: string; options: readonly (readonly [T, string])[]; value: T; onChange: (v: T) => void; className?: string;
}) {
  return (
    <div role="group" aria-label={name} className={`flex gap-1 rounded-full bg-sunken p-1 text-sm ${className}`}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}
          className="flex-1 whitespace-nowrap rounded-full px-4 py-1.5 font-semibold text-muted transition-colors hover:text-ink aria-pressed:bg-surface aria-pressed:text-accent aria-pressed:shadow-soft">
          {text}
        </button>
      ))}
    </div>
  );
}

/** Progressive disclosure on a native <details>. */
export const Disclosure = ({ summary, className = '', children }: { summary: ReactNode; className?: string; children: ReactNode }) => (
  <details className={`group ${className}`}>
    <summary className="inline-flex items-center gap-1.5 rounded-md text-sm font-semibold text-muted hover:text-accent">
      <Icon name="chevron" className="chev h-3.5 w-3.5 transition-transform" />{summary}
    </summary>
    <div className="mt-3">{children}</div>
  </details>
);

// --------------------------------------------------------------------- forms

/** Form fields as an object; blank inputs become null ("not set" to the API). */
export const formValues = (form: HTMLFormElement) =>
  Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, v === '' ? null : v])) as Record<string, string | null>;

type FieldProps = { label: ReactNode; hint?: ReactNode; className?: string };
const CONTROL = 'mt-1.5 block w-full rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-faint transition-[border-color,box-shadow] hover:border-muted focus:border-accent-solid focus:outline-none focus:ring-4 focus:ring-accent-solid/15 disabled:bg-sunken disabled:text-muted';

function Field({ label: text, hint, className, children }: FieldProps & { children: (id: string, hintId?: string) => ReactNode }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wider text-muted">{text}</label>
      {children(id, hintId)}
      {hint && <p id={hintId} className="mt-1.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export const Input = ({ label: text, hint, className, ...rest }: FieldProps & InputHTMLAttributes<HTMLInputElement>) => (
  <Field label={text} hint={hint} className={className}>{(id, h) => <input id={id} aria-describedby={h} className={CONTROL} {...rest} />}</Field>
);
export const PasswordInput = ({ label: text, hint, className, ...rest }: FieldProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) => {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={text} hint={hint} className={className}>{(id, h) => (
      <div className="relative">
        <input id={id} aria-describedby={h} type={visible ? 'text' : 'password'} className={`${CONTROL} pr-12`} {...rest} />
        <button type="button" className="absolute inset-y-1.5 right-1.5 grid w-10 place-items-center rounded-lg text-muted transition-colors hover:bg-sunken hover:text-ink focus-visible:text-accent"
          aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible} onMouseDown={(event) => event.preventDefault()}
          onClick={() => setVisible((value) => !value)}>
          <Icon name={visible ? 'eyeOff' : 'eye'} className="h-[18px] w-[18px]" />
        </button>
      </div>
    )}</Field>
  );
};
export const Textarea = ({ label: text, hint, className, ...rest }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <Field label={text} hint={hint} className={className}>{(id, h) => <textarea id={id} aria-describedby={h} className={CONTROL} {...rest} />}</Field>
);
export const Select = ({ label: text, hint, className, ...rest }: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) => (
  <Field label={text} hint={hint} className={className}>{(id, h) => <select id={id} aria-describedby={h} className={CONTROL} {...rest} />}</Field>
);
export const Checkbox = ({ label: text, ...rest }: { label: ReactNode } & InputHTMLAttributes<HTMLInputElement>) => (
  <label className="inline-flex items-start gap-2 text-sm text-ink-2">
    <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-accent-solid" {...rest} />
    <span>{text}</span>
  </label>
);

/**
 * Demo only: makes the worker fail one activity once, so Temporal's retry shows on the processing history.
 * Hidden unless DEMO_FAILURE_INJECTION is on, and even then folded away under "Developer options".
 */
export function FailureToggle({ activities, value, onChange }: { activities: readonly string[]; value?: string; onChange: (v?: string) => void }) {
  const system = useSystem();
  const [pick, setPick] = useState(activities[0]);
  if (!system.data?.demo_failure_injection) return null;
  return (
    <Disclosure summary="Developer options" className="text-left">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface-2 px-3 py-2">
        <Checkbox checked={value !== undefined} onChange={(e) => onChange(e.target.checked ? pick : undefined)}
          label={activities.length > 1 ? 'Simulate a transient failure in' : `Simulate a transient failure in “${label(ACTIVITIES, pick)}”`} />
        {activities.length > 1 && (
          <select aria-label="Step to fail once" value={pick} className="rounded-lg border border-line-strong bg-surface px-2 py-1 text-sm text-ink"
            onChange={(e) => { setPick(e.target.value); if (value) onChange(e.target.value); }}>
            {activities.map((a) => <option key={a} value={a}>{label(ACTIVITIES, a)}</option>)}
          </select>
        )}
      </div>
    </Disclosure>
  );
}

// ------------------------------------------------------------ time in flight

/** How long processing usually takes, said once. */
export const PROCESSING_HINT = 'Usually 2–8 minutes with a local model, longer the first time it loads. You can close this tab: it keeps going.';

/** A live m:ss counter from `since` (an ISO instant or epoch ms). */
export function Elapsed({ since }: { since: string | number }) {
  const start = typeof since === 'number' ? since : Date.parse(since);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const s = Math.max(0, Math.round((now - start) / 1000));
  return <span className="tabular-nums">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>;
}

// -------------------------------------------------------------------- badges

const TONES = {
  gray: 'bg-sunken text-ink-2 ring-line-strong',
  slate: 'bg-sunken text-muted ring-line-strong',
  accent: 'bg-accent-soft text-accent-ink ring-accent-line',
  green: 'bg-surface text-ok-ink ring-ok-line', // outline: found, not verified
  solidGreen: 'bg-ok text-white ring-ok',
  amber: 'bg-warn-soft text-warn-ink ring-warn-line',
  rose: 'bg-bad-soft text-bad-ink ring-bad-line',
  red: 'bg-crit-soft text-crit-ink ring-crit-line',
};
export type Tone = keyof typeof TONES;

export const Badge = ({ tone = 'gray', children }: { tone?: Tone; children: ReactNode }) => (
  <span className={`inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[11px] font-semibold ring-1 ring-inset ${TONES[tone]}`}>{children}</span>
);

const GROUP_TONES: Record<Group, Tone> = {
  expired: 'red', missing: 'rose', needs_review: 'amber', evidence: 'green', verified: 'solidGreen', not_applicable: 'slate', pending: 'gray',
};
export const GROUP_COLORS: Record<Group, string> = {
  expired: 'bg-crit-dot', missing: 'bg-bad-dot', needs_review: 'bg-warn-dot', evidence: 'bg-ok-light',
  verified: 'bg-ok-dot', not_applicable: 'bg-na-dot', pending: 'bg-line-strong',
};

/** "Evidence found" (AI, outline) vs "Verified" (you, solid); any other status you set is marked as yours. */
export function StatusBadge({ c }: { c: Pick<ChecklistDto, 'status' | 'user_verified'> | null }) {
  const g = groupOf(c);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone={GROUP_TONES[g]}>
        {g === 'verified' ? <Icon name="check" className="h-3 w-3" /> : <span className={`h-1.5 w-1.5 rounded-full ${GROUP_COLORS[g]}`} aria-hidden="true" />}
        {GROUPS[g]}
        {g === 'evidence' && <abbr title="Suggested by AI, not yet verified by you" className="rounded bg-ok-soft px-1 text-[10px] font-bold no-underline">AI</abbr>}
      </Badge>
      {c?.user_verified && g !== 'verified' && <span className="text-xs font-medium text-muted">✓ verified by you</span>}
    </span>
  );
}

export function DocStatusBadge({ status }: { status: DocumentDto['processing_status'] }) {
  if (status === 'ready') return <Badge tone="green"><Icon name="check" className="h-3 w-3" />Ready</Badge>;
  if (status === 'failed') return <Badge tone="red">Failed</Badge>;
  return <Badge tone="accent"><Spinner className="h-3 w-3" />{status === 'queued' ? 'Queued' : 'Reading'}</Badge>;
}

const RUN_TONES: Record<RunDto['status'], Tone> = { running: 'accent', completed: 'green', failed: 'red', cancelled: 'gray' };
export const RunStatusBadge = ({ status }: { status: RunDto['status'] }) => (
  <Badge tone={RUN_TONES[status]}>{status === 'running' && <Spinner className="h-3 w-3" />}{RUN_STATUSES[status]}</Badge>
);

/** Days left. On the sky it's a white pill (Flywheel's chip); on paper it uses the status tones. */
export function DeadlineBadge({ day, sky }: { day: string; sky?: boolean }) {
  const n = daysUntil(day);
  if (sky) {
    return (
      <span className={`inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-semibold shadow-pill ${n < 0 ? 'bg-crit-soft text-crit-ink' : n <= 14 ? 'bg-warn-soft text-warn-ink' : 'bg-white text-accent'}`}>
        <Icon name="calendar" className="h-3.5 w-3.5" />{countdown(n)}
      </span>
    );
  }
  return <Badge tone={n < 0 ? 'red' : n <= 14 ? 'amber' : 'gray'}><Icon name="calendar" className="h-3 w-3" />{countdown(n)}</Badge>;
}

/** Expiry date, flagged when it has passed or falls before the deadline. */
export function ExpiryNote({ expiry, deadline }: { expiry: string | null; deadline: string | null }) {
  if (!expiry) return null;
  if (expiry < today()) return <p className="text-xs font-semibold text-crit-ink">Expired on {fmtDate(expiry)}</p>;
  if (deadline && expiry < deadline) return <p className="text-xs font-semibold text-warn-ink">Expires {fmtDate(expiry)}, before your deadline</p>;
  return <p className="text-xs text-muted">Expires {fmtDate(expiry)}</p>;
}

/** Segmented bar; the legend below carries the numbers for everyone, including screen readers. */
export function StatusBar({ segments, legend = true }: { segments: { label: string; count: number; color: string }[]; legend?: boolean }) {
  const shown = segments.filter((s) => s.count > 0);
  const total = shown.reduce((n, s) => n + s.count, 0);
  return (
    <div>
      <div className="flex h-2 gap-[3px] overflow-hidden rounded-full bg-[#1e1b4b]/10" aria-hidden="true">
        {shown.map((s) => <span key={s.label} className={`${s.color} first:rounded-l-full last:rounded-r-full`} style={{ width: `${(s.count / total) * 100}%` }} />)}
      </div>
      {legend && (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink-2">
          {shown.map((s) => (
            <li key={s.label} className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${s.color}`} aria-hidden="true" />{s.label} <span className="font-semibold tabular-nums text-ink">{s.count}</span>
            </li>
          ))}
          {!total && <li className="text-muted">No requirements yet</li>}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------- brand

// The mark: two braces with blob-ended strokes, and a "bone" between them that keeps turning.
// Built from circles joined by tapered necks (generated once; same drawing as the favicon in index.html).
const MARK_BRACES = 'M13.91 24.39Q12.78 36.4 3.08 42.98A7.6 7.6 0 1 0 13.59 49.66Q15.42 38.08 25.8 31.94A8.6 8.6 0 1 0 13.91 24.39ZM3.08 57.02Q12.78 63.6 13.91 75.61A8.6 8.6 0 1 0 25.8 68.06Q15.42 61.92 13.59 50.34A7.6 7.6 0 1 0 3.08 57.02ZM74.2 31.94Q84.58 38.08 86.41 49.66A7.6 7.6 0 1 0 96.92 42.98Q87.22 36.4 86.09 24.39A8.6 8.6 0 1 0 74.2 31.94ZM86.41 50.34Q84.58 61.92 74.2 68.06A8.6 8.6 0 1 0 86.09 75.61Q87.22 63.6 96.92 57.02A7.6 7.6 0 1 0 86.41 50.34Z';
const MARK_MIDDLE = 'M37.36 47.76Q48.13 51.87 52.24 62.64A9.6 9.6 0 1 0 62.64 52.24Q51.87 48.13 47.76 37.36A9.6 9.6 0 1 0 37.36 47.76Z';

/**
 * `tone="sky"`: white braces, lime middle (on the gradient). `tone="paper"`: indigo braces, accent middle.
 * The middle piece rotates on hover; `still` freezes it.
 */
export const Logo = ({ className = 'h-6 w-6', tone = 'sky', still = false }: { className?: string; tone?: 'sky' | 'paper'; still?: boolean }) => (
  <svg viewBox="-6 -6 112 112" className={`shrink-0 ${className}`} aria-hidden="true">
    <path d={MARK_BRACES} className={tone === 'sky' ? 'fill-white' : 'fill-ink'} />
    <path d={MARK_MIDDLE} className={`${tone === 'sky' ? 'fill-pop' : 'fill-accent-solid'} ${still ? '' : 'logo-spin'}`} />
  </svg>
);

/** Logo in a translucent tile + "Paper*Trail*" in Fraunces, for the sky. */
export const Wordmark = ({ className = '' }: { className?: string }) => (
  <span className={`group inline-flex select-none items-center gap-2.5 ${className}`}>
    <span className="grid h-10 w-10 place-items-center rounded-[14px] bg-white/15 ring-1 ring-inset ring-white/30 transition-colors duration-200 group-hover:bg-white/20">
      <Logo className="h-8 w-8" />
    </span>
    <span className="font-display text-xl font-semibold tracking-tight text-white">Paper<em className="font-medium italic">Trail</em></span>
  </span>
);

export const Avatar = ({ name, sky }: { name: string; sky?: boolean }) => (
  <span aria-hidden="true" className={`grid h-9 w-9 place-items-center rounded-full text-[13px] font-bold ring-1 ring-inset ${
    sky ? 'bg-white/20 text-white ring-white/40' : 'border border-accent-line bg-accent-soft text-accent-ink ring-transparent'}`}>
    {name.trim().charAt(0).toUpperCase() || '?'}
  </span>
);
