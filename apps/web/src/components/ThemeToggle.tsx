import { Moon, Sun } from 'lucide-react';
import { useUiStore } from '../stores/ui';

export function ThemeToggle() {
  const theme = useUiStore((state) => state.theme);
  const toggleTheme = useUiStore((state) => state.toggleTheme);

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      className="rounded-lg border bg-card p-2 text-muted-foreground transition-colors hover:text-foreground"
    >
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
