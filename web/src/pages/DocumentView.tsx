// One document: the original next to its extracted text, with a cited passage (?q=) highlighted.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import type { DocumentDetail, WorkspaceDetail } from '../../../shared/schemas.ts';
import { POLL_MS, api, isProcessing } from '../api.ts';
import { DOC_CLASSES, excerptPattern, fmtBytes, fmtDate, fmtDateTime, label, plural } from '../labels.ts';
import { Link, docHref, navigate, useLocation } from '../router.tsx';
import {
  Button, Card, DocStatusBadge, Elapsed, ErrorText, ExpiryNote, Icon, Load, Notice, PROCESSING_HINT, Spinner, buttonClass,
} from '../ui.tsx';
import { RunCard } from './Activity.tsx';

export function DocumentView({ ws, did }: { ws: WorkspaceDetail; did: string }) {
  const q = useQuery({
    queryKey: ['document', did], queryFn: () => api<DocumentDetail>(`/documents/${did}`),
    refetchInterval: (q) => (q.state.data && isProcessing(q.state.data) ? POLL_MS : false),
  });
  return (
    <div className="space-y-5">
      <BackLink to={`/w/${ws.id}/documents`}>All documents</BackLink>
      <Load q={q}>{(d) => <View ws={ws} d={d} />}</Load>
    </div>
  );
}

export const BackLink = ({ to, children }: { to: string; children: ReactNode }) => (
  <Link to={to} className="inline-flex items-center gap-1.5 text-sm font-medium text-white/75 transition-colors hover:text-white">
    <Icon name="back" className="h-3.5 w-3.5" />{children}
  </Link>
);

function View({ ws, d }: { ws: WorkspaceDetail; d: DocumentDetail }) {
  const { query } = useLocation();
  const quote = query.get('q');
  const pages = d.pages ?? [];
  const fileUrl = `/api/v1/documents/${d.id}/file`;
  const isText = d.mime_type === 'text/plain';

  // Where the quote is: 1-based page, 0 = not found. A long quote may run past its page, so fall back to its first words.
  const pageOf = (re: RegExp | null) => (re ? pages.findIndex((p) => p.search(re) !== -1) + 1 : 0);
  const full = excerptPattern(quote);
  const pattern = pageOf(full) ? full : excerptPattern(quote, 8);
  const quotePage = pageOf(pattern);
  const pageCount = Math.max(1, d.page_count ?? 0, pages.length);
  const page = Math.min(pageCount, Math.max(1, Number(query.get('page')) || quotePage || 1));
  const setPage = (n: number) => navigate(docHref(ws.id, d.id, n, quote), { replace: true });

  const mark = useRef<HTMLElement>(null);
  useEffect(() => { mark.current?.scrollIntoView({ block: 'center' }); }, [page, quote, pages.length]);

  const text = useQuery({
    queryKey: ['file', d.id], enabled: isText, staleTime: Infinity,
    queryFn: () => fetch(fileUrl, { credentials: 'same-origin' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`Could not load the file (${r.status}).`)))),
  });
  const retry = useMutation({ mutationFn: () => api(`/documents/${d.id}/retry`, { method: 'POST' }) });
  const pageSelect = useId();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 gap-4">
          <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${d.role === 'requirements' ? 'bg-accent-soft text-accent-ink' : 'bg-sunken text-muted'}`}>
            <Icon name={d.role === 'requirements' ? 'list' : 'file'} className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="break-all text-xl font-semibold tracking-[-0.01em]">{d.filename}</h2>
            <p className="mt-1 text-sm text-muted">
              {[d.role === 'requirements' ? 'Requirements source' : 'Supporting document', d.classification && d.role === 'evidence' && label(DOC_CLASSES, d.classification),
                d.page_count && plural(d.page_count, 'page')].filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2" aria-live="polite">
          <DocStatusBadge status={d.processing_status} />
          <a href={fileUrl} target="_blank" rel="noopener" className={buttonClass('secondary', 'sm')}>Open original</a>
        </div>
      </div>

      {quote && pages.length > 0 && (
        <Notice className="flex items-start gap-2">
          <Icon name="quote" className="mt-0.5 h-4 w-4" />
          <span>
            {!quotePage ? 'The quoted passage could not be located exactly in the extracted text; it may be worded slightly differently.'
              : quotePage === page ? 'The highlighted passage is the one that was cited.'
              : <>The quoted passage is on page {quotePage}. <button type="button" className="font-medium underline" onClick={() => setPage(quotePage)}>Go to page {quotePage}</button></>}
          </span>
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Original">
          {d.mime_type === 'application/pdf' ? (
            <iframe key={page} src={`${fileUrl}#page=${page}`} title={`${d.filename}, page ${page}`} className="h-[70vh] w-full rounded-xl border border-line bg-surface-2" />
          ) : d.mime_type.startsWith('image/') ? (
            <img src={fileUrl} alt={`${d.filename} (original)`} className="max-h-[70vh] w-full rounded-xl border border-line object-contain" />
          ) : (
            <Load q={text}>{(t) => <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-2 p-4 text-sm">{t}</pre>}</Load>
          )}
        </Card>

        <Card title="Extracted text" actions={pages.length > 1 && (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" className="w-8 px-0" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><Icon name="back" /></Button>
            <label htmlFor={pageSelect} className="sr-only">Page</label>
            <select id={pageSelect} value={page} onChange={(e) => setPage(Number(e.target.value))} className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm">
              {pages.map((_, i) => <option key={i} value={i + 1}>Page {i + 1} of {pages.length}</option>)}
            </select>
            <Button size="sm" variant="ghost" className="w-8 px-0" disabled={page >= pages.length} onClick={() => setPage(page + 1)} aria-label="Next page"><Icon name="arrow" /></Button>
          </div>
        )}>
          {pages.length ? (
            <div role="region" tabIndex={0} aria-label={`Extracted text, page ${page}`}
              className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-2 p-4 text-sm leading-relaxed text-ink-2">
              {pages[page - 1]?.trim() ? <Highlighted text={pages[page - 1]} pattern={pattern} markRef={mark} /> : <span className="text-muted">No text on this page.</span>}
            </div>
          ) : isProcessing(d) ? (
            <div className="space-y-2 text-sm text-muted">
              <p className="flex items-center gap-2 text-accent-ink"><Spinner />Reading this document · <Elapsed since={d.created_at} /></p>
              <p className="text-xs">{PROCESSING_HINT}</p>
            </div>
          ) : <p className="text-sm text-muted">No text was extracted from this document.</p>}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Details">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
            <dt className="text-muted">Status</dt>
            <dd>
              <DocStatusBadge status={d.processing_status} />
              {d.processing_error && <p className="mt-1 break-words text-crit-ink">{d.processing_error}</p>}
              {d.processing_status === 'failed' && <Button className="mt-2" size="sm" variant="primary" busy={retry.isPending} onClick={() => retry.mutate()}>Retry processing</Button>}
              <ErrorText error={retry.error} />
            </dd>
            {d.summary && <><dt className="text-muted">Summary</dt><dd className="text-ink-2">{d.summary}</dd></>}
            <dt className="text-muted">Document date</dt><dd>{fmtDate(d.document_date)}</dd>
            <dt className="text-muted">Expiry</dt><dd>{d.expiry_date ? <ExpiryNote expiry={d.expiry_date} deadline={ws.deadline} /> : '—'}</dd>
            <dt className="text-muted">Size</dt><dd>{fmtBytes(d.size_bytes)}</dd>
            <dt className="text-muted">Uploaded</dt><dd>{fmtDateTime(d.created_at)}</dd>
          </dl>
        </Card>
        <Card title="Processing history">
          {d.runs.length ? <ol className="space-y-4">{d.runs.map((r) => <li key={r.id}><RunCard run={r} /></li>)}</ol>
            : <p className="text-sm text-muted">No processing runs recorded.</p>}
        </Card>
      </div>
    </div>
  );
}

/** The text with every match of `pattern` in <mark>; the first one gets `markRef` (to scroll to it). */
function Highlighted({ text, pattern, markRef }: { text: string; pattern: RegExp | null; markRef: RefObject<HTMLElement | null> }) {
  if (!pattern) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(pattern)) {
    out.push(text.slice(at, m.index), <mark key={m.index} ref={out.length === 0 ? markRef : undefined}>{m[0]}</mark>);
    at = m.index + m[0].length;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}
