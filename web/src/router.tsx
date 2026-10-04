// A tiny history router: pathname + query string, patterns with :params and a trailing *.
import { useEffect, useSyncExternalStore, type AnchorHTMLAttributes } from 'react';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
window.addEventListener('popstate', notify);

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => location.pathname + location.search;

export function navigate(to: string, { replace = false } = {}) {
  if (to === snapshot()) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', to);
  if (!replace) window.scrollTo(0, 0);
  notify();
}

export function useLocation() {
  const url = new URL(useSyncExternalStore(subscribe, snapshot), location.origin);
  return { pathname: url.pathname, query: url.searchParams };
}

/** `/w/:id/*` against a path: its params (the rest under '*'), or null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/').filter(Boolean);
  const got = path.split('/').filter(Boolean);
  const params: Record<string, string> = {};
  for (const [i, seg] of want.entries()) {
    if (seg === '*') return { ...params, '*': got.slice(i).join('/') };
    if (i >= got.length || (!seg.startsWith(':') && seg !== got[i])) return null;
    if (seg.startsWith(':')) params[seg.slice(1)] = got[i];
  }
  return want.length === got.length ? params : null;
}

/** A real link; plain left-clicks navigate in place, anything else (new tab, etc.) is left to the browser. */
export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}

export function Redirect({ to }: { to: string }) {
  useEffect(() => { navigate(to, { replace: true }); }, [to]);
  return null;
}

/** A document page, optionally opened at a page with a passage to highlight. */
export function docHref(workspaceId: string, documentId: string, page?: number | null, quote?: string | null) {
  const q = new URLSearchParams();
  if (page) q.set('page', String(page));
  if (quote) q.set('q', quote.slice(0, 300));
  const qs = q.toString();
  return `/w/${workspaceId}/documents/${documentId}${qs ? `?${qs}` : ''}`;
}
