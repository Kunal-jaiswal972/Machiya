import { createBrowserRouter } from 'react-router';
import { App } from './App';
import { RequireAuth } from './components/RequireAuth';
import { AccountPage } from './pages/AccountPage';
import { ForbiddenPage } from './pages/ForbiddenPage';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ForgotPasswordPage } from './pages/auth/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/auth/ResetPasswordPage';
import { SignInPage } from './pages/auth/SignInPage';
import { SignUpPage } from './pages/auth/SignUpPage';
import { VerifyEmailPage } from './pages/auth/VerifyEmailPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <HomePage /> },

      { path: 'auth/sign-in', element: <SignInPage /> },
      { path: 'auth/sign-up', element: <SignUpPage /> },
      { path: 'auth/forgot-password', element: <ForgotPasswordPage /> },
      { path: 'auth/reset-password', element: <ResetPasswordPage /> },
      { path: 'auth/verify-email', element: <VerifyEmailPage /> },

      {
        path: 'account',
        element: (
          <RequireAuth>
            <AccountPage />
          </RequireAuth>
        ),
      },

      { path: 'forbidden', element: <ForbiddenPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
