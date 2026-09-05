import { Loader2 } from 'lucide-react';
import { Suspense } from 'react';
import { Link, Outlet } from 'react-router';
import { ThemeToggle } from './components/ThemeToggle';
import { UserMenu } from './components/auth/UserMenu';

export function App() {
  return (
    <div className="flex h-full flex-col">
      <header className="z-10 flex shrink-0 items-center justify-between gap-4 border-b bg-card px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <Link to="/" className="text-base font-semibold tracking-tight">
            Machiya
          </Link>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            rentals near your office, priced with the commute
          </span>
        </div>

        <div className="flex items-center gap-2">
          <UserMenu />
          <ThemeToggle />
        </div>
      </header>

      {/* Every route below the eager set is code-split (see routes.tsx), so
          one boundary here is what covers the whole lazy half. */}
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Suspense fallback={<RouteLoading />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}

function RouteLoading() {
  return (
    <div className="flex h-full items-center justify-center" role="status">
      <Loader2 className="size-5 animate-spin text-ink-faint" aria-hidden />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
