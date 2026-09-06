import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router/dom';
import { Toaster } from 'sonner';
import { TooltipProvider } from './components/ui/tooltip';
import { AuthProvider } from './lib/auth-context';
import { queryClient } from './lib/query-client';
import { router } from './routes';
import './index.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('Missing #root element in index.html');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        {/* One provider for the app: a tooltip on a result card and one in the
            panel share a hover delay, so moving between them does not restart
            the wait. 200ms — long enough not to fire on a pass-through. */}
        <TooltipProvider delayDuration={200}>
          <RouterProvider router={router} />
        </TooltipProvider>
        <Toaster position="bottom-right" richColors closeButton />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
