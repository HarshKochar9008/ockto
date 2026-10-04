// Tasks and their reminders. Reminders are durable timers on the server; this page schedules and shows them.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReminderDto, TaskDto, WorkspaceDetail } from '../../../shared/schemas.ts';
import { api, useSystem, useTasks } from '../api.ts';
import { REMINDER_STATUSES, fmtDateTime, fromLocalInput, toLocalInput } from '../labels.ts';
import {
  Badge, Button, Card, Checkbox, ConfirmDelete, EmptyState, ErrorText, FailureToggle, Icon, Input, Load, Spinner, Textarea, formValues, type Tone,
} from '../ui.tsx';

export function Tasks({ ws }: { ws: WorkspaceDetail }) {
  const q = useTasks(ws.id);
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-8 lg:col-span-2">
        <Load q={q}>{(tasks) => {
          const open = tasks.filter((t) => t.status === 'open');
          const closed = tasks.filter((t) => t.status !== 'open');
          return (
            <>
              <section aria-labelledby="open-tasks">
                <h2 id="open-tasks" className="mb-4 flex items-center gap-2 font-display text-2xl font-medium text-white">
                  Open <span className="rounded-full bg-white/20 px-2 py-0.5 font-sans text-xs font-bold tabular-nums">{open.length}</span>
                </h2>
                {open.length
                  ? <ul className="space-y-3">{open.map((t) => <li key={t.id}><TaskCard t={t} /></li>)}</ul>
                  : <EmptyState sky title="No open tasks" icon="check">The analysis adds a task for anything missing or needing review. You can add your own too.</EmptyState>}
              </section>
              {closed.length > 0 && (
                <section aria-labelledby="closed-tasks">
                  <h2 id="closed-tasks" className="mb-4 flex items-center gap-2 font-display text-2xl font-medium text-white/85">
                    Done and <em className="italic">dismissed</em> <span className="rounded-full bg-white/20 px-2 py-0.5 font-sans text-xs font-bold tabular-nums">{closed.length}</span>
                  </h2>
                  <ul className="space-y-3">{closed.map((t) => <li key={t.id}><TaskCard t={t} /></li>)}</ul>
                </section>
              )}
            </>
          );
        }}</Load>
      </div>
      <Card title="New task" className="h-fit lg:sticky lg:top-24"><TaskForm wsId={ws.id} /></Card>
    </div>
  );
}

export function TaskForm({ wsId, checklistItemId, defaultTitle, onDone }: { wsId: string; checklistItemId?: string; defaultTitle?: string; onDone?: () => void }) {
  const create = useMutation({ mutationFn: (body: object) => api<TaskDto>(`/workspaces/${wsId}/tasks`, { json: body }) });
  return (
    <form className="space-y-4" onSubmit={(e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const v = formValues(form);
      create.mutate(
        { title: v.title, notes: v.notes, due_at: v.due_at && fromLocalInput(v.due_at), checklist_item_id: checklistItemId },
        { onSuccess: () => { form.reset(); onDone?.(); } },
      );
    }}>
      <Input label="Title" name="title" required maxLength={200} defaultValue={defaultTitle} placeholder="Ask Dr. Lee for a second letter" />
      <Input label="Due (optional)" name="due_at" type="datetime-local" />
      <Textarea label="Notes (optional)" name="notes" rows={3} maxLength={2000} />
      <ErrorText error={create.error} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" busy={create.isPending}><Icon name="plus" />Add task</Button>
        {create.isSuccess && !onDone && <p role="status" className="flex items-center gap-1.5 text-sm text-ok-ink"><Icon name="check" />Added</p>}
      </div>
    </form>
  );
}

function TaskCard({ t }: { t: TaskDto }) {
  const [panel, setPanel] = useState<'edit' | 'remind' | null>(null);
  const patch = useMutation({ mutationFn: (body: object) => api(`/tasks/${t.id}`, { method: 'PATCH', json: body }) });
  const remove = useMutation({ mutationFn: () => api(`/tasks/${t.id}`, { method: 'DELETE' }) });
  const cancel = useMutation({ mutationFn: () => api(`/tasks/${t.id}/reminders`, { method: 'DELETE' }) });
  const open = t.status === 'open';
  const overdue = open && t.due_at !== null && Date.parse(t.due_at) < Date.now();
  const toggle = (p: 'edit' | 'remind') => setPanel(panel === p ? null : p);
  return (
    <article className={`card rounded-3xl p-5 ${open ? '' : 'opacity-80'}`}>
      <div className="flex items-start gap-3.5">
        <button type="button" disabled={patch.isPending} onClick={() => patch.mutate({ status: open ? 'done' : 'open' })}
          aria-label={open ? `Mark “${t.title}” done` : `Reopen “${t.title}”`}
          className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-[1.5px] transition-colors ${
            open ? 'border-line-strong text-transparent hover:border-ok hover:text-ok' : 'border-ok bg-ok text-white'}`}>
          {patch.isPending ? <Spinner className="h-3 w-3 text-muted" /> : <Icon name="check" className="h-3 w-3" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className={`break-words text-[15px] font-medium ${open ? 'text-ink' : 'text-muted line-through'}`}>{t.title}</h3>
            {open && <Button size="sm" variant="ghost" disabled={patch.isPending} onClick={() => patch.mutate({ status: 'dismissed' })}>Dismiss</Button>}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            <Badge tone={t.origin === 'analysis' ? 'accent' : 'gray'}>{t.origin === 'analysis' ? 'From analysis' : 'Yours'}</Badge>
            {!open && <Badge>{t.status === 'done' ? 'Done' : 'Dismissed'}</Badge>}
            <span className={`inline-flex items-center gap-1 ${overdue ? 'font-medium text-crit-ink' : ''}`}>
              <Icon name="calendar" className="h-3 w-3" />{t.due_at ? `${overdue ? 'Overdue since' : 'Due'} ${fmtDateTime(t.due_at)}` : 'No due date'}
            </span>
          </p>
          {t.notes && panel !== 'edit' && <p className="mt-2 whitespace-pre-wrap text-sm text-ink-2">{t.notes}</p>}
          {t.reminders.length > 0 && <Reminders reminders={t.reminders} />}
          <div className="-ml-2.5 mt-2 flex flex-wrap items-center gap-1">
            <Button size="sm" variant="ghost" aria-expanded={panel === 'edit'} onClick={() => toggle('edit')}>Edit</Button>
            {open && <Button size="sm" variant="ghost" aria-expanded={panel === 'remind'} onClick={() => toggle('remind')}><Icon name="clock" className="h-3.5 w-3.5" />Remind me</Button>}
            {t.reminders.some((r) => r.delivery_status === 'scheduled') && (
              <Button size="sm" variant="ghost" busy={cancel.isPending} onClick={() => cancel.mutate()}>Cancel reminders</Button>
            )}
            <ConfirmDelete prompt="Delete this task and its reminders?" busy={remove.isPending} onConfirm={() => remove.mutate()} />
          </div>
          <ErrorText error={patch.error ?? remove.error ?? cancel.error} />
          {panel === 'edit' && <TaskEdit t={t} onDone={() => setPanel(null)} />}
          {panel === 'remind' && <ReminderForm t={t} onDone={() => setPanel(null)} />}
        </div>
      </div>
    </article>
  );
}

function TaskEdit({ t, onDone }: { t: TaskDto; onDone: () => void }) {
  const save = useMutation({ mutationFn: (body: object) => api(`/tasks/${t.id}`, { method: 'PATCH', json: body }), onSuccess: onDone });
  return (
    <form className="mt-3 space-y-4 rounded-xl border border-accent-line bg-surface p-4" onSubmit={(e) => {
      e.preventDefault();
      const v = formValues(e.currentTarget);
      save.mutate({ title: v.title, notes: v.notes, due_at: v.due_at && fromLocalInput(v.due_at) });
    }}>
      <Input label="Title" name="title" required maxLength={200} defaultValue={t.title} />
      <Input label="Due" name="due_at" type="datetime-local" defaultValue={toLocalInput(t.due_at)} />
      <Textarea label="Notes" name="notes" rows={3} maxLength={2000} defaultValue={t.notes ?? ''} />
      <ErrorText error={save.error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" busy={save.isPending}>Save</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

const REMINDER_TONES: Record<ReminderDto['delivery_status'], Tone> = { scheduled: 'accent', sent: 'green', suppressed: 'slate', cancelled: 'gray', failed: 'red' };

function Reminders({ reminders }: { reminders: ReminderDto[] }) {
  return (
    <div className="mt-3 rounded-xl bg-surface-2 p-3 ring-1 ring-inset ring-line">
      <h4 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Reminders</h4>
      <ul aria-live="polite" className="mt-1.5 space-y-1.5 text-sm">
        {reminders.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="tabular-nums">{fmtDateTime(r.scheduled_at)}</span>
            <Badge tone={REMINDER_TONES[r.delivery_status]}>{REMINDER_STATUSES[r.delivery_status]}</Badge>
            {r.sent_at && <span className="text-xs text-muted">sent {fmtDateTime(r.sent_at)}{r.channel && ` via ${r.channel === 'webhook' ? 'webhook' : 'the app'}`}</span>}
            {r.detail && <span className="text-xs text-muted">{r.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

const HOUR = 3_600_000;

function ReminderForm({ t, onDone }: { t: TaskDto; onDone: () => void }) {
  const system = useSystem();
  const [inject, setInject] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const schedule = useMutation({
    mutationFn: (remind_at: string[]) => api(`/tasks/${t.id}/reminders`, { json: { remind_at, inject_failure: inject } }),
    onSuccess: onDone,
  });
  const due = t.due_at ? Date.parse(t.due_at) : null;
  // Times are computed when submitting, so "in 1 minute" means a minute from the click. That one is for demos only.
  const presets: [string, string, (() => number) | null][] = [
    ...(system.data?.demo_failure_injection ? [['soon', 'In 1 minute', () => Date.now() + 60_000] as [string, string, () => number]] : []),
    ['hour', '1 hour before due', due ? () => due - HOUR : null],
    ['day', '1 day before due', due ? () => due - 24 * HOUR : null],
    ['week', '1 week before due', due ? () => due - 168 * HOUR : null],
  ];
  return (
    <form className="mt-3 space-y-4 rounded-xl border border-accent-line bg-surface p-4" onSubmit={(e) => {
      e.preventDefault();
      const data = new FormData(e.currentTarget);
      const custom = data.get('custom') as string;
      const times = presets.filter(([key, , at]) => at && data.has(key)).map(([, , at]) => new Date(at!()).toISOString());
      if (custom) times.push(fromLocalInput(custom));
      if (!times.length) return setProblem('Choose at least one reminder time.');
      setProblem(undefined);
      schedule.mutate(times);
    }}>
      <fieldset>
        <legend className="text-[13px] font-medium text-ink-2">Remind me</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {presets.map(([key, text, at]) => {
            const why = !at ? 'needs a due date' : at() < Date.now() ? 'already passed' : null;
            return <Checkbox key={key} name={key} disabled={Boolean(why)} label={<>{text}{why && <span className="text-xs text-muted"> ({why})</span>}</>} />;
          })}
        </div>
      </fieldset>
      <Input label="Or at a specific time" name="custom" type="datetime-local" className="max-w-xs" />
      <FailureToggle activities={['deliverReminder']} value={inject} onChange={setInject} />
      {problem && <p role="alert" className="text-sm text-crit-ink">{problem}</p>}
      <ErrorText error={schedule.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="primary" busy={schedule.isPending}>Schedule reminders</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Close</Button>
      </div>
      <p className="text-xs text-muted">New reminders replace any still scheduled. They stop when the task is done or dismissed.</p>
    </form>
  );
}
