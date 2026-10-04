// Account, what happens to your documents, and (folded away) how this server is set up.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Me, SystemStatus } from '../../../shared/schemas.ts';
import { api, useSystem } from '../api.ts';
import { navigate } from '../router.tsx';
import { Avatar, Badge, Button, Card, Disclosure, ErrorText, Icon, Load, PageHeader, type IconName } from '../ui.tsx';

const OnOff = ({ on, text }: { on: boolean; text: string }) => <><Badge tone={on ? 'green' : 'gray'}>{on ? 'On' : 'Off'}</Badge> <span className="text-muted">{text}</span></>;

const integrations = (s: SystemStatus): [string, ReactNode][] => [
  ['AI endpoint', <code className="break-all font-mono text-xs">{s.ai.base_url}</code>],
  ['Chat model', s.ai.chat_model],
  ['Embedding model', s.ai.embedding_model],
  ['OCR model', s.ai.ocr_model ?? 'Not configured: scanned PDFs and photos cannot be read'],
  ['File storage', s.storage === 's3' ? 'S3-compatible object storage' : 'Local disk on the server'],
  ['Error tracking', <OnOff on={s.sentry} text="Sentry" />],
  ['Reminder webhook', <OnOff on={s.reminder_webhook} text={s.reminder_webhook ? 'reminders are also posted to a webhook' : 'reminders show in the app only'} />],
  ['Workflows', <a href={s.temporal_ui_url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">Open the Temporal UI</a>],
  ['Demo failure switch', <OnOff on={s.demo_failure_injection} text="lets you make one step fail once, to see the retry" />],
];

export function Settings({ me }: { me: Me }) {
  const system = useSystem();
  const qc = useQueryClient();
  const signOut = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      qc.clear();
      qc.setQueryData(['me'], null);
      navigate('/');
    },
  });
  const storage = system.data?.storage === 's3' ? 'S3-compatible object storage' : 'the server’s disk';
  const privacy: [IconName, ReactNode][] = [
    ['check', 'AI assessments are suggestions. The checklist always shows whether a status came from the AI or from you.'],
    ['x', 'Deleting a document removes the file, its extracted text, its search chunks and their embeddings. Checklist items it supported go back to “Needs review”.'],
    ['file', <>The original files stay in the configured file storage ({storage}). Only you can open them while signed in.</>],
    ['sparkle', 'To read, classify and check your documents, their text is sent to the configured AI model. With a model running on your own server, the text stays on that server.'],
    ['shield', 'Error reports and traces, when enabled, are tagged with IDs rather than document text or file names.'],
  ];
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Profile" className="h-fit">
          <div className="flex items-center gap-3">
            <Avatar name={me.name} />
            <div className="min-w-0">
              <p className="truncate font-medium">{me.name}</p>
              <p className="truncate text-sm text-muted">{me.email}</p>
            </div>
          </div>
          <Button className="mt-6" busy={signOut.isPending} onClick={() => signOut.mutate()}>Sign out</Button>
          <ErrorText error={signOut.error} />
        </Card>

        <Card title="Your documents and privacy" className="lg:col-span-2">
          <ul className="space-y-3.5 text-sm text-ink-2">
            {privacy.map(([icon, text], i) => (
              <li key={i} className="flex gap-3">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-sunken text-muted"><Icon name={icon} className="h-3.5 w-3.5" /></span>
                <span className="pt-1">{text}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="lg:col-span-3">
          <Disclosure summary="System status">
            <Load q={system}>{(s) => (
              <dl className="divide-y divide-line text-sm">
                {integrations(s).map(([term, value]) => (
                  <div key={term} className="grid gap-1 py-2.5 sm:grid-cols-[12rem_1fr]">
                    <dt className="text-muted">{term}</dt><dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}</Load>
          </Disclosure>
        </Card>
      </div>
    </>
  );
}
