import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router/dom';
import { Toaster } from 'sonner';
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
        <RouterProvider router={router} />
        <Toaster position="bottom-right" richColors closeButton />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
