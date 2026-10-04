// Questions about this application, answered with cited passages; plus plain document search.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import type { AnswerDto, RequirementDto, SearchHit, WorkspaceDetail } from '../../../shared/schemas.ts';
import { ApiError, api, useDocuments, useRequirements } from '../api.ts';
import { Link, docHref } from '../router.tsx';
import { Badge, Button, Card, Elapsed, EmptyState, Icon, IconTile, Input, Load, Notice, Spinner, buttonClass } from '../ui.tsx';

type Turn = { id: number; question: string; answer?: AnswerDto; error?: string }; // id = when it was asked

/** Suggestions built from what this application actually contains, never from demo data. */
function suggestionsFor(ws: WorkspaceDetail, reqs: RequirementDto[]): string[] {
  const confirmed = reqs.filter((r) => r.confirmed);
  const review = confirmed.find((r) => r.checklist?.status === 'needs_review');
  return [
    review && `Why is “${review.title}” marked for review?`,
    confirmed.some((r) => r.checklist?.status === 'missing') && 'Which documents are still missing?',
    ws.deadline && 'Which documents expire before my deadline?',
    reqs.some((r) => r.due_date) && 'When is my next deadline?',
    'What is still left to do?',
  ].filter((s): s is string => Boolean(s)).slice(0, 4);
}

export function Assistant({ ws }: { ws: WorkspaceDetail }) {
  const docs = useDocuments(ws.id);
  const ready = docs.data?.some((d) => d.processing_status === 'ready');
  if (docs.isSuccess && !ready) {
    const reading = docs.data.length > 0;
    return (
      <EmptyState sky title={reading ? 'Your documents are still being read' : 'Upload documents first'} icon="chat"
        action={<Link to={`/w/${ws.id}/documents`} className={buttonClass(reading ? 'glass' : 'light')}>{reading ? 'See documents' : 'Upload documents'}</Link>}>
        Then ask anything about them: what’s missing, what expires, what a document says. Every answer cites its passage.
      </EmptyState>
    );
  }
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Chat ws={ws} />
      <SearchPanel ws={ws} />
    </div>
  );
}

function Chat({ ws }: { ws: WorkspaceDetail }) {
  const qc = useQueryClient();
  const reqs = useRequirements(ws.id);
  const key = ['chat', ws.id];
  // Lives in the query cache (never fetched), so the conversation survives opening a cited document and coming back.
  const chat = useQuery({ queryKey: key, queryFn: () => [] as Turn[], initialData: [] as Turn[], enabled: false, gcTime: Infinity });
  const [question, setQuestion] = useState('');
  const waiting = chat.data.some((t) => !t.answer && !t.error);
  const suggestions = suggestionsFor(ws, reqs.data ?? []);

  async function ask(text: string) {
    const id = Date.now();
    const update = (patch: Partial<Turn>) => qc.setQueryData<Turn[]>(key, (all = []) => all.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    qc.setQueryData<Turn[]>(key, (all = []) => [...all, { id, question: text }]);
    setQuestion('');
    try {
      update({ answer: await api<AnswerDto>(`/workspaces/${ws.id}/ask`, { json: { question: text } }) });
    } catch (err) {
      const message = (err as Error).message;
      update({ error: err instanceof ApiError && err.status === 502 ? `The AI model did not answer. ${message} Please try again in a moment.` : message });
    }
  }

  return (
    <section aria-labelledby="ask-title" className="card flex min-w-0 flex-col overflow-hidden rounded-3xl lg:col-span-2">
      <div className="flex items-start gap-3 border-b border-line px-5 py-4 sm:px-6">
        <IconTile name="sparkle" size="sm" />
        <div>
          <h2 id="ask-title" className="font-display text-lg font-semibold">Ask about this application</h2>
          <p className="text-sm text-muted">Answers draw on your requirements, checklist and documents, and cite the passages they rely on.</p>
        </div>
      </div>
      <div aria-live="polite" className="flex-1 space-y-6 px-5 py-5 sm:px-6">
        {chat.data.length ? chat.data.map((t) => <TurnView key={t.id} t={t} ws={ws} />)
          : <p className="text-sm text-muted">Ask a question, or start with one of these.</p>}
      </div>
      <form className="space-y-3 border-t border-line bg-white/50 px-5 py-4 sm:px-6" onSubmit={(e) => { e.preventDefault(); if (question.trim().length >= 2) void ask(question.trim()); }}>
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <button key={s} type="button" disabled={waiting} onClick={() => void ask(s)}
              className="rounded-full border border-line-strong bg-surface px-3 py-1.5 text-xs text-ink-2 transition-colors hover:border-accent hover:text-accent disabled:opacity-50">
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <Input label="Your question" className="flex-1" value={question} onChange={(e) => setQuestion(e.target.value)} minLength={2} maxLength={1000}
            placeholder="Does my transcript show a GPA?" />
          <Button type="submit" variant="primary" busy={waiting}>Ask</Button>
        </div>
        <p className="text-xs text-muted">Answers can be wrong. Check them against the cited sources.</p>
      </form>
    </section>
  );
}

function TurnView({ t, ws }: { t: Turn; ws: WorkspaceDetail }) {
  return (
    <div className="space-y-3">
      <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-sm text-accent-ink">
        <span className="sr-only">You asked: </span>{t.question}
      </p>
      {t.answer ? <Answer a={t.answer} ws={ws} turn={t.id} />
        : t.error ? <Notice tone="error">{t.error}</Notice>
        : (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-sm text-ink-2">
            <span className="text-accent"><Spinner /></span>Reading your documents and writing an answer. A local model can take 30 to 90 seconds.
            <span aria-hidden="true" className="text-muted"><Elapsed since={t.id} /></span>
          </div>
        )}
    </div>
  );
}

/** The answer, with [P1] / [P1, P3] markers turned into links to the matching citation below. */
function Answer({ a, ws, turn }: { a: AnswerDto; ws: WorkspaceDetail; turn: number }) {
  const cited = new Set(a.citations.map((c) => c.ref));
  const anchor = (ref: string) => `cite-${turn}-${ref}`;
  return (
    <div className="rounded-2xl rounded-bl-md border border-line p-4 sm:p-5">
      {a.insufficient_evidence && (
        <Notice tone="warn" className="mb-3">
          <strong>Insufficient evidence.</strong> Your documents don’t clearly answer this. Treat the answer as a pointer, not a fact.
        </Notice>
      )}
      <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">
        {a.answer.split(/\[(P\d+(?:\s*,\s*P\d+)*)\]/).map((part, i) => i % 2 === 0 ? part : (
          <Fragment key={i}>{part.split(/\s*,\s*/).map((ref, j) => (
            <Fragment key={ref}>{j > 0 && ' '}{cited.has(ref)
              ? <a href={`#${anchor(ref)}`} className="mx-0.5 inline-grid h-5 min-w-5 place-items-center rounded-md bg-accent-soft px-1 align-[1px] font-mono text-[11px] font-semibold text-accent-ink no-underline hover:bg-accent hover:text-white">{ref.slice(1)}</a>
              : `[${ref}]`}</Fragment>
          ))}</Fragment>
        ))}
      </p>
      {a.citations.length > 0 && (
        <>
          <h3 className="mt-5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Sources</h3>
          <ol className="mt-2 space-y-2">
            {a.citations.map((c) => (
              <li key={c.ref} id={anchor(c.ref)} className="flex scroll-mt-24 gap-3 rounded-xl bg-surface-2 p-3 text-sm ring-1 ring-inset ring-line target:ring-2 target:ring-accent">
                <span className="grid h-5 min-w-5 place-items-center rounded-md bg-accent-soft px-1 font-mono text-[11px] font-semibold text-accent-ink">{c.ref.slice(1)}</span>
                <div className="min-w-0">
                  <Link to={docHref(ws.id, c.document_id, c.page_number, c.excerpt)} className="break-all font-medium hover:text-accent">
                    {c.filename}{c.page_number ? ` · p.${c.page_number}` : ''}
                  </Link>
                  <p className="mt-1 line-clamp-3 text-muted">{c.excerpt}</p>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function SearchPanel({ ws }: { ws: WorkspaceDetail }) {
  const [term, setTerm] = useState('');
  const hits = useQuery({
    queryKey: ['search', ws.id, term], enabled: term.length >= 2, staleTime: Infinity, retry: false,
    queryFn: () => api<SearchHit[]>(`/workspaces/${ws.id}/search`, { json: { query: term } }),
  });
  return (
    <Card title="Search documents" description="Exact words and passages with a similar meaning." className="h-fit">
      <form role="search" className="flex items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); setTerm(String(new FormData(e.currentTarget).get('query') ?? '').trim()); }}>
        <Input label="Words or a phrase" name="query" className="flex-1" required minLength={2} maxLength={500} />
        <Button type="submit" busy={hits.isFetching} aria-label="Search" className="w-9 px-0">{!hits.isFetching && <Icon name="search" />}</Button>
      </form>
      {term.length >= 2 && (
        <div className="mt-5" aria-live="polite">
          <Load q={hits}>{(list) => list.length ? (
            <ul className="-my-2 divide-y divide-line">
              {list.map((h) => (
                <li key={h.chunk_id} className="py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={docHref(ws.id, h.document_id, h.page_number, h.content)} className="break-all font-medium text-accent hover:underline">
                      {h.filename}{h.page_number ? ` · p.${h.page_number}` : ''}
                    </Link>
                    <Badge tone={h.role === 'requirements' ? 'accent' : 'gray'}>{h.role === 'requirements' ? 'Requirements' : 'Supporting'}</Badge>
                  </div>
                  <p className="mt-1 line-clamp-3 text-muted">{h.content}</p>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">No matches.</p>}</Load>
        </div>
      )}
    </Card>
  );
}
