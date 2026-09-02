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

      <main className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
