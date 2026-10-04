// Fetch wrapper for /api/v1 (cookie session, JSON in and out) and the queries several pages share.
// No optimistic updates anywhere: after a write, what's on screen is refetched (see `refresh`).
import { useQuery, type QueryClient } from '@tanstack/react-query';
import type {
  AuditDto, DocumentDto, Me, RequirementDto, RunDto, SystemStatus, TaskDto, WorkspaceDetail,
} from '../../shared/schemas.ts';

export class ApiError extends Error {
  status: number;
  issues: { path: string; message: string }[];
  constructor(status: number, message: string, issues: { path: string; message: string }[] = []) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

interface Init { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> }

export async function api<T = unknown>(path: string, { method, json, body, headers }: Init = {}): Promise<T> {
  if (json !== undefined) [body, headers] = [JSON.stringify(json), { ...headers, 'content-type': 'application/json' }];
  const res = await fetch(`/api/v1${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), body, headers, credentials: 'same-origin' })
    .catch(() => Promise.reject(new ApiError(0, 'Could not reach PaperTrail. Check your connection and try again.')));
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `The server answered ${res.status}. Please try again.`, data?.issues);
  return data as T;
}

/** The raw file is the body; its name travels in a header (kept out of access logs). 200 = already uploaded. */
export const uploadDocument = (workspaceId: string, file: File, role: DocumentDto['role'], injectFailure?: string) =>
  api<{ document: DocumentDto; duplicate: boolean }>(
    `/workspaces/${workspaceId}/documents?${new URLSearchParams({ role, ...(injectFailure ? { inject_failure: injectFailure } : {}) })}`,
    { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) } },
  );

// Data no write changes, or that only lives in this tab.
const KEEP = new Set(['me', 'system', 'chat', 'search']);
/** After every write (wired up once, in main.tsx): the server is authoritative, so refetch what is on screen. */
export const refresh = (qc: QueryClient) => qc.invalidateQueries({ predicate: (q) => !KEEP.has(String(q.queryKey[0])) });

// ------------------------------------------------------------------ queries
// Polling only while something is in flight.

export const POLL_MS = 2500;
export const isProcessing = (d: Pick<DocumentDto, 'processing_status'>) => d.processing_status === 'queued' || d.processing_status === 'processing';

export const useMe = () => useQuery({
  queryKey: ['me'], staleTime: Infinity,
  queryFn: () => api<Me>('/auth/me').catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))),
});

export const useSystem = () => useQuery({ queryKey: ['system'], queryFn: () => api<SystemStatus>('/system'), staleTime: Infinity });

export const useWorkspace = (id: string) => useQuery({
  queryKey: ['workspace', id], queryFn: () => api<WorkspaceDetail>(`/workspaces/${id}`),
  refetchInterval: (q) => (q.state.data?.analysis?.status === 'running' || q.state.data?.counts.processing ? POLL_MS : false),
});

export const useRequirements = (id: string) =>
  useQuery({ queryKey: ['requirements', id], queryFn: () => api<RequirementDto[]>(`/workspaces/${id}/requirements`) });

export const useDocuments = (id: string) => useQuery({
  queryKey: ['documents', id], queryFn: () => api<DocumentDto[]>(`/workspaces/${id}/documents`),
  refetchInterval: (q) => (q.state.data?.some(isProcessing) ? POLL_MS : false),
});

/** Polls while a reminder is about to go out, so its delivery status shows up. */
export const useTasks = (id: string) => useQuery({
  queryKey: ['tasks', id], queryFn: () => api<TaskDto[]>(`/workspaces/${id}/tasks`),
  refetchInterval: (q) => (q.state.data?.some((t) => t.reminders.some((r) => r.delivery_status === 'scheduled' && Date.parse(r.scheduled_at) < Date.now() + 120_000))
    ? POLL_MS : false),
});

export interface ActivityDto { runs: RunDto[]; audit: AuditDto[] }
export const useActivity = (id: string, poll = false) => useQuery({
  queryKey: ['activity', id], queryFn: () => api<ActivityDto>(`/workspaces/${id}/activity`),
  refetchInterval: (q) => (poll && q.state.data?.runs.some((r) => r.status === 'running') ? POLL_MS : false),
});
