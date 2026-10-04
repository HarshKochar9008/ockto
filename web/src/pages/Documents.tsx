// Documents: upload (drag and drop or picker), reading state, retry, expiry warnings, delete.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { DocumentDto, WorkspaceDetail } from '../../../shared/schemas.ts';
import { api, isProcessing, uploadDocument, useDocuments } from '../api.ts';
import { DOC_CLASSES, fmtBytes, fmtDate, label, plural } from '../labels.ts';
import { Link, docHref } from '../router.tsx';
import {
  Badge, Button, Card, ConfirmDelete, DocStatusBadge, Elapsed, EmptyState, ErrorText, ExpiryNote, FailureToggle, Icon, Load, PROCESSING_HINT,
  Segmented, Spinner,
} from '../ui.tsx';
import { HistoryLink } from './Overview.tsx';

const TYPICAL = ['Transcript', 'Language test', 'Passport', 'CV', 'Recommendation letters', 'Personal statement'];

export function Documents({ ws }: { ws: WorkspaceDetail }) {
  const q = useDocuments(ws.id);
  const none = q.data?.length === 0;
  return (
    <div className="space-y-6">
      <Card emphasis={none} title="Upload documents" description="Each file is read, classified and indexed, so every requirement can point at the passage that proves it.">
        <UploadZone wsId={ws.id} />
        {none && (
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Usually needed:</span>
            {TYPICAL.map((t) => <span key={t} className="rounded-full bg-sunken px-2.5 py-1 text-xs text-ink-2">{t}</span>)}
          </div>
        )}
      </Card>
      <Card title="Your documents">
        <Load q={q}>{(docs) => {
          const busy = docs.filter(isProcessing).length;
          return docs.length ? (
            <>
              <p aria-live="polite" className="flex items-center gap-2 text-sm text-muted">
                {busy ? <><span className="text-accent"><Spinner /></span>{plural(busy, 'document')} being read. This list updates by itself.</> : `${plural(docs.length, 'document')}, all read.`}
              </p>
              {busy > 0 && <p className="mt-1 text-xs text-faint">{PROCESSING_HINT}</p>}
              <ul className="mt-4 divide-y divide-line">{docs.map((d) => <DocumentRow key={d.id} ws={ws} d={d} />)}</ul>
            </>
          ) : (
            <EmptyState title="No documents yet" icon="file">Upload transcripts, certificates, your passport, CV and letters: PDF, PNG, JPEG or plain text.</EmptyState>
          );
        }}</Load>
      </Card>
      <HistoryLink wsId={ws.id} />
    </div>
  );
}

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.txt';
// The steps each kind of document goes through, for the demo failure switch.
const STEPS = {
  evidence: ['extractText', 'classifyDocument', 'indexDocument'],
  requirements: ['extractText', 'indexDocument', 'extractRequirements'],
} as const;
const ROLES = [['evidence', 'Your documents'], ['requirements', 'Requirements']] as const;

type Result = { name: string; state: 'uploading' | 'uploaded' | 'duplicate' | 'failed'; message?: string; docId?: string };

/** Uploads one file after another. Pass `role` to fix it (the Requirements page does). */
export function UploadZone({ wsId, role: fixedRole }: { wsId: string; role?: DocumentDto['role'] }) {
  const [role, setRole] = useState<DocumentDto['role']>(fixedRole ?? 'evidence');
  const [inject, setInject] = useState<string>();
  const [over, setOver] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      setResults(files.map((f) => ({ name: f.name, state: 'uploading' })));
      for (const [i, file] of files.entries()) {
        let r: Partial<Result>;
        try {
          const res = await uploadDocument(wsId, file, role, inject);
          r = { state: res.duplicate ? 'duplicate' : 'uploaded', docId: res.document.id };
        } catch (err) {
          r = { state: 'failed', message: (err as Error).message };
        }
        setResults((all) => all.map((x, j) => (j === i ? { ...x, ...r } : x)));
      }
    },
  });
  const pick = (files: FileList | null) => {
    if (files?.length && !upload.isPending) upload.mutate([...files]);
  };
  // Successful uploads show up in the document list with their live status; only problems stay here.
  const shown = results.filter((r) => r.state !== 'uploaded' || upload.isPending);

  return (
    <div className="space-y-4">
      {!fixedRole && (
        <Segmented label="What are you uploading?" options={ROLES} value={role} className="sm:inline-flex"
          onChange={(r) => { setRole(r); setInject(undefined); }} />
      )}
      <label
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files); }}
        className={`flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15 ${
          over ? 'border-accent bg-accent-soft' : 'border-line-strong bg-surface-2 hover:border-accent-line hover:bg-accent-soft/40'} ${
          upload.isPending ? 'pointer-events-none opacity-70' : ''}`}
      >
        <input type="file" multiple accept={ACCEPT} disabled={upload.isPending} className="sr-only"
          onChange={(e) => { pick(e.currentTarget.files); e.currentTarget.value = ''; }} />
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface text-accent shadow-card ring-1 ring-line">
          {upload.isPending ? <Spinner className="h-5 w-5" /> : <Icon name="upload" className="h-5 w-5" />}
        </span>
        <span className="mt-4 text-[15px] font-medium text-ink">
          {role === 'requirements' ? 'Add the requirements PDF or text file' : 'Add your documents'}
        </span>
        <span className="mt-1 text-sm text-muted">Drop files here or <span className="font-medium text-accent">browse</span></span>
        <span className="mt-3 text-xs text-faint">PDF, PNG, JPEG or plain text. Several at once is fine.</span>
      </label>
      <FailureToggle key={role} activities={STEPS[role]} value={inject} onChange={setInject} />
      {shown.length > 0 && (
        <ul aria-live="polite" className="space-y-2 text-sm">
          {shown.map((r, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <Icon name="file" className="h-4 w-4 text-muted" />
              <span className="break-all font-medium">{r.name}</span>
              {r.state === 'uploading' && <Spinner label="Uploading…" />}
              {r.state === 'uploaded' && <Badge tone="green"><Icon name="check" className="h-3 w-3" />Uploaded</Badge>}
              {r.state === 'duplicate' && (
                <>
                  <Badge>Already uploaded</Badge>
                  <Link to={docHref(wsId, r.docId!)} className="text-xs font-medium text-accent hover:underline">Open the existing copy</Link>
                </>
              )}
              {r.state === 'failed' && <><Badge tone="red">Not uploaded</Badge><span className="text-xs text-crit-ink">{r.message}</span></>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DocumentRow({ ws, d }: { ws: WorkspaceDetail; d: DocumentDto }) {
  const retry = useMutation({ mutationFn: () => api(`/documents/${d.id}/retry`, { method: 'POST' }) });
  const remove = useMutation({ mutationFn: () => api(`/documents/${d.id}`, { method: 'DELETE' }) });
  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="flex min-w-0 gap-3.5">
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${d.role === 'requirements' ? 'bg-accent-soft text-accent-ink' : 'bg-sunken text-muted'}`}>
          <Icon name={d.role === 'requirements' ? 'list' : 'file'} className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 space-y-1">
          <Link to={docHref(ws.id, d.id)} className="break-all text-[15px] font-medium text-ink hover:text-accent">{d.filename}</Link>
          <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
            <span>{d.role === 'requirements' ? 'Requirements source' : d.classification ? label(DOC_CLASSES, d.classification) : 'Supporting document'}</span>
            <span aria-hidden="true">·</span><span>{fmtBytes(d.size_bytes)}</span>
            <span aria-hidden="true">·</span><span>Uploaded {fmtDate(d.created_at)}</span>
          </p>
          <ExpiryNote expiry={d.expiry_date} deadline={ws.deadline} />
          {isProcessing(d) && <p className="text-xs text-muted">Reading for <span className="font-medium text-ink-2"><Elapsed since={d.created_at} /></span></p>}
          {d.processing_status === 'failed' && <p className="break-words text-sm text-crit-ink">{d.processing_error ?? 'Processing failed.'}</p>}
          <ErrorText error={retry.error ?? remove.error} />
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 pl-[54px] sm:pl-0">
        <DocStatusBadge status={d.processing_status} />
        {d.processing_status === 'failed' && <Button size="sm" variant="primary" busy={retry.isPending} onClick={() => retry.mutate()}>Retry</Button>}
        <ConfirmDelete prompt="Delete the file, its text and search index?" busy={remove.isPending} onConfirm={() => remove.mutate()} />
      </div>
    </li>
  );
}
