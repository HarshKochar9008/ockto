// Requirements: add them (document, pasted text or by hand), check the AI's drafts, confirm them.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { DocumentDto, RequirementDto, WorkspaceDetail } from '../../../shared/schemas.ts';
import { api, isProcessing, useDocuments, useRequirements } from '../api.ts';
import { assessedBy, fmtDate, plural } from '../labels.ts';
import { Link, docHref } from '../router.tsx';
import {
  Button, Card, Checkbox, ConfirmDelete, Disclosure, DocStatusBadge, Elapsed, EmptyState, ErrorText, Icon, Input, Load, Notice, PROCESSING_HINT,
  Segmented, Spinner, StatusBadge, Textarea, buttonClass, formValues,
} from '../ui.tsx';
import { UploadZone } from './Documents.tsx';

export function Requirements({ ws }: { ws: WorkspaceDetail }) {
  const reqs = useRequirements(ws.id);
  const docs = useDocuments(ws.id);
  const confirm = useMutation({ mutationFn: () => api(`/workspaces/${ws.id}/requirements/confirm`, { method: 'POST' }) });
  const sources = docs.data?.filter((d) => d.role === 'requirements') ?? [];
  const reading = sources.filter(isProcessing);
  return (
    <div className="space-y-6">
      <Load q={reqs}>{(list) => {
        const drafts = list.filter((r) => !r.confirmed);
        const confirmed = list.filter((r) => r.confirmed);
        return (
          <>
            <AddRequirements ws={ws} sources={sources} collapsed={list.length > 0} />
            {drafts.length > 0 && (
              <Card emphasis title={`Check ${plural(drafts.length, 'draft')}`}
                description="Compare each with the quoted source, then edit or delete it. Nothing is analysed until you confirm."
                actions={<Button variant="primary" busy={confirm.isPending} onClick={() => confirm.mutate()}>
                  <Icon name="check" />Confirm {drafts.length === 1 ? 'it' : `all ${drafts.length}`}
                </Button>}>
                <ErrorText error={confirm.error} />
                <ul className="space-y-3">{drafts.map((r) => <RequirementItem key={r.id} ws={ws} r={r} />)}</ul>
                <p className="mt-4 text-xs text-muted">You can still edit requirements after confirming them.</p>
              </Card>
            )}
            {(confirmed.length > 0 || !drafts.length) && (
              <Card title="Confirmed requirements" description={confirmed.length ? plural(confirmed.length, 'requirement') : undefined}>
                {confirmed.length
                  ? <ul className="space-y-3">{confirmed.map((r) => <RequirementItem key={r.id} ws={ws} r={r} />)}</ul>
                  : reading.length
                    ? <EmptyState title={`Extracting requirements from ${reading.map((d) => d.filename).join(', ')}`}
                        action={<Link to={`/w/${ws.id}/documents`} className={buttonClass('primary')}>While you wait, upload your documents<Icon name="arrow" /></Link>}>
                        Drafts appear here when it finishes. {PROCESSING_HINT}
                      </EmptyState>
                    : <EmptyState title="No requirements yet" icon="list">Upload the programme’s requirements, paste them, or type them in above.</EmptyState>}
              </Card>
            )}
          </>
        );
      }}</Load>
    </div>
  );
}

const MODES = [['upload', 'Upload'], ['paste', 'Paste'], ['manual', 'Type it']] as const;

/** Full card while there are no requirements; afterwards folded away under "Add more requirements". */
function AddRequirements({ ws, sources, collapsed }: { ws: WorkspaceDetail; sources: DocumentDto[]; collapsed: boolean }) {
  const [mode, setMode] = useState<(typeof MODES)[number][0]>('upload');
  const body = (
    <>
      <Segmented label="How to add requirements" options={MODES} value={mode} onChange={setMode} className="sm:inline-flex sm:min-w-80" />
      <div className="mt-5">
        {mode === 'upload' && <UploadZone wsId={ws.id} role="requirements" />}
        {mode === 'paste' && <PasteRequirements wsId={ws.id} />}
        {mode === 'manual' && <ManualRequirement wsId={ws.id} />}
      </div>
    </>
  );
  if (collapsed) {
    return (
      <Card>
        {sources.length > 0 && <Sources wsId={ws.id} docs={sources} />}
        <Disclosure summary="Add more requirements" className={sources.length ? 'mt-4 border-t border-line pt-4' : ''}>{body}</Disclosure>
      </Card>
    );
  }
  return (
    <Card emphasis={!sources.length} title="Add the programme’s requirements"
      description="Upload the requirements page or PDF, paste the text, or type them in. The AI drafts a checklist; you check every item.">
      {body}
      {sources.length > 0 && <div className="mt-6 border-t border-line pt-5"><Sources wsId={ws.id} docs={sources} /></div>}
    </Card>
  );
}

function Sources({ wsId, docs }: { wsId: string; docs: DocumentDto[] }) {
  return (
    <div>
      <h3 className="text-[13px] font-semibold text-ink-2">Requirement sources</h3>
      <ul className="mt-2 space-y-2.5" aria-live="polite">
        {docs.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <Icon name="file" className="h-4 w-4 text-muted" />
            <Link to={docHref(wsId, d.id)} className="break-all font-medium hover:text-accent">{d.filename}</Link>
            <DocStatusBadge status={d.processing_status} />
            {isProcessing(d) && (
              <span className="text-xs text-muted">Extracting requirements · <span className="font-medium text-ink-2"><Elapsed since={d.created_at} /></span></span>
            )}
            {d.processing_error && <span className="text-xs text-crit-ink">{d.processing_error}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PasteRequirements({ wsId }: { wsId: string }) {
  const extract = useMutation({
    mutationFn: (text: string) => api<{ duplicate: boolean }>(`/workspaces/${wsId}/requirements/extract`, { json: { text } }),
  });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); extract.mutate(String(new FormData(e.currentTarget).get('text'))); }}>
      <Textarea label="Requirements text" name="text" rows={8} required minLength={20} maxLength={50_000}
        hint="Paste the eligibility and document requirements from the programme page." />
      <ErrorText error={extract.error} />
      {extract.data && (
        <Notice>
          {extract.data.duplicate
            ? 'This exact text was submitted before; its drafts are below.'
            : <span className="flex items-start gap-2"><Spinner className="mt-0.5 h-4 w-4" />Extracting requirements. Drafts appear below. {PROCESSING_HINT}</span>}
        </Notice>
      )}
      <Button type="submit" variant="primary" busy={extract.isPending}>Extract requirements</Button>
    </form>
  );
}

const requirementBody = (form: HTMLFormElement) => {
  const v = formValues(form);
  return { title: v.title, description: v.description ?? '', required: v.required === 'on', due_date: v.due_date };
};

function ManualRequirement({ wsId }: { wsId: string }) {
  const add = useMutation({ mutationFn: (body: object) => api(`/workspaces/${wsId}/requirements`, { json: body }) });
  return (
    <form className="space-y-4" onSubmit={(e) => {
      e.preventDefault();
      const form = e.currentTarget;
      add.mutate(requirementBody(form), { onSuccess: () => form.reset() });
    }}>
      <Input label="Requirement" name="title" required maxLength={200} placeholder="IELTS Academic, 6.5 overall" />
      <Textarea label="Details (optional)" name="description" rows={2} maxLength={2000} />
      <div className="flex flex-wrap items-end gap-4">
        <Input label="Due date (optional)" name="due_date" type="date" />
        <div className="pb-2.5"><Checkbox label="Required" name="required" defaultChecked /></div>
      </div>
      <ErrorText error={add.error} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" busy={add.isPending}>Add requirement</Button>
        {add.isSuccess
          ? <p role="status" className="flex items-center gap-1.5 text-sm text-ok-ink"><Icon name="check" />Added</p>
          : <p className="text-xs text-muted">Requirements you type are confirmed straight away.</p>}
      </div>
    </form>
  );
}

function RequirementItem({ ws, r }: { ws: WorkspaceDetail; r: RequirementDto }) {
  const [editing, setEditing] = useState(false);
  const remove = useMutation({ mutationFn: () => api(`/requirements/${r.id}`, { method: 'DELETE' }) });
  if (editing) return <li><RequirementEdit r={r} onDone={() => setEditing(false)} /></li>;
  return (
    <li className="rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-[15px] font-medium text-ink">
            {r.confirmed ? <Link to={`/w/${ws.id}/requirements/${r.id}`} className="hover:text-accent">{r.title}</Link> : r.title}
          </h3>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
            <span>{r.required ? 'Required' : 'Optional'}</span>
            {r.due_date && <span>Due {fmtDate(r.due_date)}</span>}
            <span>{r.origin === 'ai' ? 'Extracted by AI' : 'Added by you'}</span>
          </p>
        </div>
        {r.confirmed && (
          <div className="sm:text-right">
            <StatusBadge c={r.checklist} />
            <p className="mt-1 text-xs text-muted">{assessedBy(r)}</p>
          </div>
        )}
      </div>
      {r.description && <p className="mt-3 whitespace-pre-wrap text-sm text-ink-2">{r.description}</p>}
      {r.ambiguity && <Notice tone="warn" className="mt-3"><strong>Check this:</strong> {r.ambiguity}</Notice>}
      {r.source_excerpt && (
        <figure className="mt-3 rounded-lg bg-surface-2 p-3">
          <blockquote className="border-l-2 border-line-strong pl-3 text-sm text-ink-2">“{r.source_excerpt}”</blockquote>
          {r.source_document_id && (
            <figcaption className="mt-2 pl-3.5 text-xs">
              <Link to={docHref(ws.id, r.source_document_id, r.source_page, r.source_excerpt)} className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
                <Icon name="file" className="h-3.5 w-3.5" />View in source{r.source_page ? `, page ${r.source_page}` : ''}
              </Link>
            </figcaption>
          )}
        </figure>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
        <ConfirmDelete prompt="Delete this requirement?" busy={remove.isPending} onConfirm={() => remove.mutate()} />
      </div>
      <ErrorText error={remove.error} />
    </li>
  );
}

function RequirementEdit({ r, onDone }: { r: RequirementDto; onDone: () => void }) {
  const save = useMutation({ mutationFn: (body: object) => api(`/requirements/${r.id}`, { method: 'PATCH', json: body }), onSuccess: onDone });
  return (
    <form className="space-y-4 rounded-xl border border-accent-line bg-surface p-4 shadow-lift sm:p-5" onSubmit={(e) => { e.preventDefault(); save.mutate(requirementBody(e.currentTarget)); }}>
      <Input label="Requirement" name="title" defaultValue={r.title} required maxLength={200} autoFocus />
      <Textarea label="Details" name="description" defaultValue={r.description} rows={3} maxLength={2000} />
      <div className="flex flex-wrap items-end gap-4">
        <Input label="Due date" name="due_date" type="date" defaultValue={r.due_date ?? ''} />
        <div className="pb-2.5"><Checkbox label="Required" name="required" defaultChecked={r.required} /></div>
      </div>
      {r.confirmed && <p className="text-xs text-muted">Saving clears your verification of this item and marks its assessment out of date.</p>}
      <ErrorText error={save.error} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" busy={save.isPending}>Save</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
