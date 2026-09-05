import { NavLink, Outlet } from 'react-router';
import { cn } from '../../lib/utils';

const TABS = [
  { to: '/admin', end: true, label: 'Moderation' },
  { to: '/admin/demand', end: false, label: 'Where next' },
  { to: '/admin/fuel', end: false, label: 'Scrape health' },
  { to: '/admin/users', end: false, label: 'Users' },
];

/**
 * The admin shell.
 *
 * Moderation first because it is the only queue that grows on its own, and
 * "where next" second because it is the question this product is actually
 * trying to answer for itself. Users are last: an admin page that only lists
 * users answers neither "what is broken" nor "where should we expand".
 */
export function AdminPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-title">Admin</h1>
        <p className="text-sm text-ink-soft">
          What needs reviewing, what is failing, and where people are asking us to go.
        </p>
      </header>

      <nav aria-label="Admin sections" className="flex flex-wrap gap-1.5">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                'text-label rounded-[var(--radius-chrome)] border px-2.5 py-1',
                isActive
                  ? 'border-water bg-water-soft'
                  : 'border-edge-strong text-ink-soft hover:bg-paper-sunken',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
