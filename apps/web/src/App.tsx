import { Outlet } from 'react-router';
import { ThemeToggle } from './components/ThemeToggle';

export function App() {
  return (
    <div className="flex h-full flex-col">
      <header className="z-10 flex shrink-0 items-center justify-between border-b bg-card px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-base font-semibold tracking-tight">Machiya</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            rentals near your office, priced with the commute
          </span>
        </div>
        <ThemeToggle />
      </header>

      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
