import { createBrowserRouter } from 'react-router';
import { App } from './App';
import { RequireAuth, RequireRole } from './components/RequireAuth';
import { RouteError } from './components/RouteError';
import { AccountPage } from './pages/AccountPage';
import { ForbiddenPage } from './pages/ForbiddenPage';
import { FuelHealthPage } from './pages/admin/FuelHealthPage';
import { ListingDetailRoute } from './pages/ListingDetailRoute';
import { SearchPage } from './pages/SearchPage';
import { DashboardPage } from './pages/lister/DashboardPage';
import { WizardPage } from './pages/lister/WizardPage';
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
    // Per-route error boundaries with a retry that re-runs the route rather
    // than reloading the page — reloading would throw away the search state.
    errorElement: <RouteError />,
    children: [
      // The detail view is a CHILD of the search page, not a sibling: that is
      // what keeps the WebGL map mounted across the navigation instead of
      // tearing it down, refetching every tile and losing the camera.
      {
        element: <SearchPage />,
        errorElement: <RouteError />,
        children: [
          { index: true, element: null },
          {
            path: 'listings/:slug',
            element: <ListingDetailRoute />,
            errorElement: <RouteError />,
          },
        ],
      },

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

      {
        path: 'admin/fuel',
        element: (
          <RequireRole minimum="ADMIN">
            <FuelHealthPage />
          </RequireRole>
        ),
        errorElement: <RouteError />,
      },

      {
        path: 'lister',
        element: (
          <RequireAuth>
            <DashboardPage />
          </RequireAuth>
        ),
        errorElement: <RouteError />,
      },

      // No role gate: a seeker drafts a listing and becomes a lister by
      // publishing one. The upgrade happens server-side inside the publish
      // transaction, never here.
      {
        path: 'lister/listings/new',
        element: (
          <RequireAuth>
            <WizardPage />
          </RequireAuth>
        ),
        errorElement: <RouteError />,
      },
      {
        path: 'lister/listings/:id/edit',
        element: (
          <RequireAuth>
            <WizardPage />
          </RequireAuth>
        ),
        errorElement: <RouteError />,
      },

      { path: 'forbidden', element: <ForbiddenPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
