// Signed out: the pitch on the sky, one product moment that shows the evidence, then create an account (or sign in).
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Me } from '../../../shared/schemas.ts';
import { api } from '../api.ts';
import {
  Button, ErrorText, Icon, IconTile, Input, Notice, PasswordInput, StatusBadge, Wordmark, buttonClass, formValues, useTitle, type IconName,
} from '../ui.tsx';

type Mode = 'signup' | 'login';

const STEPS: [IconName, string, string][] = [
  ['flag', 'Add the requirements', 'Upload the programme’s requirements or paste them. PaperTrail drafts a checklist; you confirm every item.'],
  ['file', 'Add your documents', 'Transcripts, test scores, passport, CV, letters. Each one is read, classified and indexed.'],
  ['check', 'Check your checklist', 'Every requirement gets a status with the exact passage behind it. You verify; the AI never decides.'],
];

const REASONS: [IconName, string, string][] = [
  ['quote', 'Every status cites a passage', 'Open any item and see the exact page and sentence the assessment relies on.'],
  ['check', 'You verify, not the AI', 'Findings stay marked as suggestions until you check them. Your decision always wins.'],
  ['calendar', 'Deadlines and expiry, tracked', 'Documents that expire before your deadline are flagged, with reminders that survive restarts.'],
  ['shield', 'Your documents, your call', 'Delete a document and its file, extracted text and search index are removed with it.'],
];

const TRUST = ['Every status links to its source', 'Nothing is verified until you check it', 'Free, no card, two fields to start'];

// A static slice of a real checklist, so the product is clear before signing up. Fictional data.
const ROWS = [
  { title: 'Official transcript', source: 'transcript-alex-rivera.pdf · p.1', c: { status: 'satisfied', user_verified: true } },
  { title: 'English test, 6.5 overall', source: 'aet-score-report.pdf · p.1', c: { status: 'needs_review', user_verified: false }, selected: true },
  { title: 'Two recommendation letters', source: 'letters-2026.pdf · p.2', c: { status: 'satisfied', user_verified: false } },
  { title: 'Valid passport', source: 'No matching document yet', c: { status: 'missing', user_verified: false } },
] as const;

export function Landing({ unavailable = false }: { unavailable?: boolean }) {
  useTitle('Know what your application still needs');
  const [mode, setMode] = useState<Mode>('signup');
  const qc = useQueryClient();
  const auth = useMutation({
    mutationFn: (body: Record<string, string | null>) => api<Me>(`/auth/${mode}`, { json: body }),
    onSuccess: (me) => qc.setQueryData(['me'], me),
  });
  const switchTo = (m: Mode) => { setMode(m); auth.reset(); };
  const submitAuth = (form: HTMLFormElement) => {
    const values = formValues(form);
    if (mode === 'signup') values.name = (values.email ?? '').split('@')[0];
    auth.mutate(values);
  };
  /** Brings the account card into view with its first field focused (hero, header and final CTA use it). */
  const openAuth = (m: Mode) => {
    switchTo(m);
    document.querySelector<HTMLInputElement>('#auth input')?.focus({ preventScroll: true });
    document.getElementById('auth')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const cta = (text: string) => (
    <a href="#auth" className={buttonClass('light', 'lg')} onClick={(e) => { e.preventDefault(); openAuth('signup'); }}>
      {text}<Icon name="arrow" />
    </a>
  );

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-white/15 bg-white/10 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Wordmark />
          <nav aria-label="Sections" className="hidden items-center gap-2 text-sm md:flex">
            {[['#how', 'How it works'], ['#example', 'Example'], ['#why', 'Why trust it']].map(([href, text]) => (
              <a key={href} href={href} className="rounded-full px-4 py-1.5 font-medium text-white/75 transition hover:bg-white/10 hover:text-white">{text}</a>
            ))}
          </nav>
          <Button variant="glass" size="sm" className="ml-auto" onClick={() => openAuth('login')}>Sign in</Button>
        </div>
      </header>

      <main>
        <section className="relative isolate overflow-hidden">
          <span aria-hidden="true" className="shooting-star -z-10" style={{ top: '12%', right: '6%' }} />
          <span aria-hidden="true" className="shooting-star -z-10" style={{ top: '40%', right: '32%', animationDelay: '3.4s', animationDuration: '9.5s', width: '90px' }} />
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-20 pt-12 sm:px-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-16 lg:pt-20">
            <div className="animate-in min-w-0">
              <p className="inline-flex items-center gap-2 rounded-full border border-white/40 bg-white/15 px-3.5 py-1 text-xs font-semibold text-white backdrop-blur-sm">
                <Icon name="sparkle" className="h-3.5 w-3.5" />For university and scholarship applications
              </p>
              <h1 className="sky-shadow mt-6 font-display text-5xl font-medium leading-[1.05] text-white sm:text-6xl">
                Know exactly what your application <em className="italic">still needs.</em>
              </h1>
              <p className="mt-6 max-w-xl text-base leading-relaxed text-white/90 [text-shadow:0_1px_16px_rgba(30,27,75,0.35)] sm:text-lg">
                PaperTrail reads the programme’s requirements, checks them against your own documents, and shows the exact passage behind
                every item: what’s covered, what’s missing, and what expires before the deadline.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                {cta('Check my application, free')}
                <a href="#example" className={buttonClass('glass', 'lg')}>See an example</a>
              </div>
              <ul className="mt-8 space-y-2.5 text-sm text-white/90">
                {TRUST.map((t) => (
                  <li key={t} className="flex items-center gap-2.5">
                    <span className="grid h-5 w-5 place-items-center rounded-full bg-white/25 text-white"><Icon name="check" className="h-3 w-3" /></span>{t}
                  </li>
                ))}
              </ul>
            </div>

            <AuthCard mode={mode} onMode={switchTo} unavailable={unavailable} pending={auth.isPending} error={auth.error}
              onSubmit={submitAuth} />
          </div>
        </section>

        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <section id="how" className="scroll-mt-24 py-16 sm:py-20">
            <SectionHead eyebrow="How it works" title="Three small" em="steps." />
            <div className="mt-10 grid gap-5 md:grid-cols-3">
              {STEPS.map(([icon, title, body], i) => (
                <div key={title} className="card card-hover relative overflow-hidden rounded-3xl p-6">
                  <div className="flex items-center justify-between">
                    <IconTile name={icon} />
                    <span className="font-display text-3xl font-medium italic text-ink/20">0{i + 1}</span>
                  </div>
                  <h3 className="mt-4 font-display text-xl font-semibold">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-2">{body}</p>
                  <Ghost icon={icon} />
                </div>
              ))}
            </div>
          </section>

          <section id="example" className="scroll-mt-24 py-16 sm:py-20">
            <SectionHead eyebrow="How it looks" title="See what’s missing," em="and why." />
            <ProductPreview />
          </section>

          <section id="why" className="relative isolate scroll-mt-24 py-16 sm:py-20">
            <div aria-hidden="true" className="section-stars -z-10" />
            <span aria-hidden="true" className="shooting-star -z-10" style={{ top: '8%', right: '10%', animationDelay: '1.2s' }} />
            <span aria-hidden="true" className="shooting-star -z-10" style={{ top: '30%', right: '48%', animationDelay: '6.1s', animationDuration: '11s' }} />
            <SectionHead eyebrow="Why trust it" title="Your documents," em="your call." />
            <div className="mt-10 grid gap-5 sm:grid-cols-2">
              {REASONS.map(([icon, title, body]) => (
                <div key={title} className="card card-hover relative flex items-start gap-4 overflow-hidden rounded-3xl p-6">
                  <IconTile name={icon} />
                  <div>
                    <h3 className="font-display text-lg font-semibold">{title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-ink-2">{body}</p>
                  </div>
                  <Ghost icon={icon} />
                </div>
              ))}
            </div>
          </section>

          <section className="py-20 text-center sm:py-24">
            <h2 className="sky-shadow mx-auto max-w-2xl font-display text-4xl font-medium leading-tight text-white sm:text-5xl">
              Ready to <em className="italic">check it?</em>
            </h2>
            <p className="mx-auto mt-4 max-w-md text-base text-white/85">Your deadline is closer than it looks. Find the gaps while there’s still time to fix them.</p>
            <div className="mt-8 flex justify-center">{cta('Start my checklist')}</div>
          </section>
        </div>
      </main>

      <footer className="pb-10 text-center text-xs text-white/70">PaperTrail · AI suggestions, your decisions.</footer>
    </div>
  );
}

const SectionHead = ({ eyebrow, title, em }: { eyebrow: string; title: string; em: string }) => (
  <>
    <p className="text-center text-xs font-bold uppercase tracking-[0.25em] text-white/70">{eyebrow}</p>
    <h2 className="sky-shadow mt-3 text-center font-display text-3xl font-medium text-white sm:text-4xl">
      {title} <em className="italic">{em}</em>
    </h2>
  </>
);

/** Flywheel's oversized, barely-there icon in a card's corner. */
const Ghost = ({ icon }: { icon: IconName }) => (
  <span aria-hidden="true" className="pointer-events-none absolute -bottom-6 -right-4 text-ink/[0.05]"><Icon name={icon} className="h-28 w-28" /></span>
);

function AuthCard({ mode, onMode, unavailable, pending, error, onSubmit }: {
  mode: Mode; onMode: (m: Mode) => void; unavailable: boolean; pending: boolean; error: unknown; onSubmit: (form: HTMLFormElement) => void;
}) {
  const signup = mode === 'signup';
  return (
    <section id="auth" aria-labelledby="auth-title" className="card animate-in scroll-mt-24 rounded-3xl p-6 shadow-lift ring-4 ring-white/40 sm:p-7">
      <h2 id="auth-title" className="font-display text-2xl font-semibold">{signup ? <>Start your <em className="font-medium italic">checklist</em></> : <>Welcome <em className="font-medium italic">back</em></>}</h2>
      <p className="mt-1 text-sm text-ink-2">{signup ? 'Free. Two fields and you’re in.' : 'Sign in to pick up where you left off.'}</p>
      {unavailable && <Notice tone="warn" className="mt-4">PaperTrail’s server isn’t answering right now. Try again in a moment.</Notice>}
      <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); onSubmit(e.currentTarget); }}>
        <Input label="Email" name="email" type="email" autoComplete="email" required maxLength={254} placeholder="you@example.com" />
        <PasswordInput label="Password" name="password" required maxLength={200}
          autoComplete={signup ? 'new-password' : 'current-password'}
          minLength={signup ? 10 : undefined} hint={signup ? 'At least 10 characters.' : undefined} />
        <ErrorText error={error} />
        <Button type="submit" variant="primary" size="lg" className="w-full" busy={pending}>{signup ? 'Create account' : 'Sign in'}</Button>
      </form>
      <p className="mt-4 text-center text-sm text-ink-2">
        {signup ? 'Already have an account? ' : 'New to PaperTrail? '}
        <button type="button" className="font-semibold text-accent underline-offset-4 hover:underline" onClick={() => onMode(signup ? 'login' : 'signup')}>
          {signup ? 'Sign in' : 'Create an account'}
        </button>
      </p>
      <p className="mt-5 flex gap-2.5 border-t border-line pt-4 text-xs leading-relaxed text-muted">
        <Icon name="shield" className="mt-px h-4 w-4 text-ok-ink" />
        Your documents are only used to check your application. Delete one and its file, extracted text and search index are removed.
      </p>
    </section>
  );
}

/** The product moment: a checklist next to the passage behind one of its statuses. Decorative, nothing in it is interactive. */
function ProductPreview() {
  return (
    <figure className="card mt-10 overflow-hidden rounded-3xl">
      <div className="flex items-center gap-3 border-b border-line bg-white/60 px-5 py-3.5">
        <span className="flex gap-1.5" aria-hidden="true">{['bg-bad-dot', 'bg-warn-dot', 'bg-ok-dot'].map((c) => <span key={c} className={`h-2.5 w-2.5 rounded-full ${c} opacity-70`} />)}</span>
        <span className="min-w-0 truncate font-display text-sm font-semibold">MSc Data Science · Northbridge University</span>
        <span className="ml-auto hidden text-xs font-medium text-muted sm:inline">Deadline 15 Jan 2027</span>
      </div>
      <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <ul className="divide-y divide-line border-b border-line md:border-b-0 md:border-r">
          {ROWS.map((r) => (
            <li key={r.title} className={`flex flex-wrap items-center justify-between gap-2 px-5 py-4 ${'selected' in r ? 'bg-accent-soft/70 shadow-[inset_3px_0_0_var(--color-accent-solid)]' : ''}`}>
              <div className="min-w-0">
                <p className="text-sm font-semibold">{r.title}</p>
                <p className="mt-0.5 text-xs text-muted">{r.source}</p>
              </div>
              <StatusBadge c={r.c} />
            </li>
          ))}
        </ul>
        <div className="p-5 sm:p-7">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">Why it needs a closer look</p>
          <h3 className="mt-2 font-display text-xl font-semibold">English test, 6.5 overall</h3>
          <p className="mt-2 flex items-center gap-2 text-sm font-semibold text-warn-ink">
            <Icon name="alert" />Expires 12 Dec 2026, before your 15 Jan 2027 deadline
          </p>
          <blockquote className="mt-5 rounded-2xl bg-surface p-4 text-[15px] leading-relaxed text-ink-2 shadow-soft">
            “Overall band score: 6.5. Listening 7.0, Reading 6.5, Writing 6.0, Speaking 6.5.{' '}
            <mark>This result is valid until 12 December 2026.</mark>”
            <span className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-accent"><Icon name="file" className="h-3.5 w-3.5" />aet-score-report.pdf · page 1</span>
          </blockquote>
          <div className="mt-5 flex flex-wrap gap-2" aria-hidden="true">
            <span className={buttonClass('primary', 'sm')}>Verify</span>
            <span className={buttonClass('secondary', 'sm')}>Create a task: renew the test</span>
          </div>
        </div>
      </div>
    </figure>
  );
}
