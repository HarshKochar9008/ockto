// Entry: fonts, query client, the sign-in gate, top-level routes and the app chrome.
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/fraunces/opsz-italic.css';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Me } from '../../shared/schemas.ts';
import { ApiError, refresh, useMe } from './api.ts';
import './index.css';
import { Dashboard } from './pages/Dashboard.tsx';
import { Landing } from './pages/Landing.tsx';
import { Settings } from './pages/Settings.tsx';
import { Workspace } from './pages/Workspace.tsx';
import { Link, Redirect, matchPath, useLocation } from './router.tsx';
import { Avatar, ErrorState, Icon, Logo, NotFound, Spinner, Wordmark, type IconName } from './ui.tsx';

// A 401 from any request means the session is gone: back to the sign-in page.
const signedOut = (err: unknown) => {
  if (err instanceof ApiError && err.status === 401) qc.setQueryData(['me'], null);
};

const qc: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: signedOut }),
  mutationCache: new MutationCache({ onError: signedOut, onSuccess: () => refresh(qc) }),
  defaultOptions: {
    queries: { staleTime: 5_000, retry: (n, err) => n < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500) },
  },
});

function App() {
  const me = useMe();
  const { pathname } = useLocation();
  if (me.isPending) {
    return <div className="grid min-h-screen place-items-center text-white"><Logo className="h-16 w-16" /><span className="sr-only"><Spinner label="Loading PaperTrail…" /></span></div>;
  }
  // Signed out, or the server is unreachable: the pitch still shows; the sign-in card says what's wrong.
  if (me.isError || !me.data) return <Landing unavailable={me.isError} />;
  if (pathname === '/') return <Redirect to="/dashboard" />;
  return <Chrome me={me.data}><Boundary path={pathname}>{route(pathname, me.data)}</Boundary></Chrome>;
}

function route(pathname: string, me: Me): ReactNode {
  if (pathname === '/dashboard') return <Dashboard />;
  if (pathname === '/settings') return <Settings me={me} />;
  const w = matchPath('/w/:id/*', pathname);
  return w ? <Workspace key={w.id} id={w.id} rest={w['*']} /> : <NotFound />;
}

/** A render error shows a message instead of a blank page; navigating elsewhere clears it. */
class Boundary extends Component<{ path: string; children: ReactNode }, { error: unknown; path: string }> {
  state = { error: null as unknown, path: this.props.path };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  static getDerivedStateFromProps(props: { path: string }, state: { path: string }) {
    return props.path === state.path ? null : { error: null, path: props.path };
  }
  render() {
    return this.state.error ? <ErrorState error={this.state.error} onRetry={() => location.reload()} /> : this.props.children;
  }
}

/** One icon in the rail: lime when current, like the reference dashboard. */
function RailLink({ to, icon, label, current }: { to: string; icon: IconName; label: string; current?: boolean }) {
  return (
    <Link to={to} aria-current={current ? 'page' : undefined} title={label}
      className="grid h-11 w-11 place-items-center rounded-full text-white/80 transition hover:bg-white/15 hover:text-white aria-[current=page]:bg-pop aria-[current=page]:text-pop-ink aria-[current=page]:shadow-[0_8px_20px_-6px_rgba(54,69,8,0.45)]">
      <Icon name={icon} className="h-5 w-5" /><span className="sr-only">{label}</span>
    </Link>
  );
}

function Chrome({ me, children }: { me: Me; children: ReactNode }) {
  const { pathname } = useLocation();
  const inApps = pathname === '/dashboard' || pathname.startsWith('/w/');
  return (
    <div className="flex min-h-screen flex-col lg:pl-24">
      <a href="#main" className="sr-only rounded-full bg-white px-4 py-2 font-semibold text-accent focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50">Skip to content</a>
      {/* Desktop: a floating glass rail. Phones and tablets keep the top bar below. */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-24 items-center justify-center py-5 lg:flex print:hidden">
        <nav aria-label="Main" className="flex h-full w-16 flex-col items-center gap-2 rounded-[2rem] border border-white/20 bg-white/15 py-4 shadow-[0_24px_60px_-24px_rgba(30,27,75,0.55)] backdrop-blur-xl">
          <Link to="/dashboard" title="PaperTrail" className="mb-5 grid h-12 w-12 place-items-center rounded-2xl bg-white/15 ring-1 ring-inset ring-white/30">
            <Logo className="h-9 w-9" /><span className="sr-only">PaperTrail home</span>
          </Link>
          <RailLink to="/dashboard" icon="home" label="Applications" current={inApps} />
          <RailLink to="/dashboard?new=1" icon="plus" label="New application" />
          <RailLink to="/settings" icon="sliders" label="Settings" current={pathname === '/settings'} />
          <Link to="/settings" title={`${me.name} · Settings`} className="mt-auto rounded-full transition hover:ring-4 hover:ring-white/25">
            <Avatar name={me.name} sky /><span className="sr-only">Settings for {me.name}</span>
          </Link>
        </nav>
      </aside>
      <header className="sticky top-0 z-40 border-b border-white/15 bg-white/10 backdrop-blur-xl lg:hidden print:hidden">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link to="/dashboard" className="rounded-2xl" title="PaperTrail"><Wordmark /></Link>
          <nav aria-label="Main" className="flex items-center gap-2 text-sm">
            <Link to="/dashboard" aria-current={inApps ? 'page' : undefined}
              className="rounded-full px-4 py-1.5 font-medium text-white/75 transition hover:bg-white/10 hover:text-white aria-[current=page]:bg-white/25 aria-[current=page]:text-white aria-[current=page]:shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]">
              Applications
            </Link>
            <Link to="/settings" aria-current={pathname === '/settings' ? 'page' : undefined} title={`${me.name} · Settings`}
              className="rounded-full transition hover:ring-4 hover:ring-white/25 aria-[current=page]:ring-2 aria-[current=page]:ring-white">
              <Avatar name={me.name} sky /><span className="sr-only">Settings for {me.name}</span>
            </Link>
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 outline-none sm:px-6 sm:py-10 print:max-w-none print:p-0">{children}</main>
      <footer className="pb-10 pt-6 text-center text-xs text-white/70 print:hidden">PaperTrail · AI suggestions, your decisions.</footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
