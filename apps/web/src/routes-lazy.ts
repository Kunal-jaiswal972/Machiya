import { lazy } from 'react';

/**
 * The search, the detail panel and the auth screens are eager. Everything below
 * is lazy, and that split is not arbitrary: the eager set is what an anonymous
 * visitor lands on, and the lazy set is what somebody signs in to do.
 *
 * The lister dashboard pulls recharts — roughly 400 KB — into a bundle whose
 * main job is a map search no seeker needs a chart for, and the admin pages are
 * reachable by a handful of people.
 *
 * Route-level `lazy` rather than `manualChunks`, which D12 records as unsafe
 * here: forcing maplibre into a manual chunk severs it from its worker and
 * blanks the map with no error at all.
 */
const EnquiriesPage = lazy(() =>
  import('./pages/EnquiriesPage').then((module) => ({ default: module.EnquiriesPage })),
);
const SavedPage = lazy(() =>
  import('./pages/SavedPage').then((module) => ({ default: module.SavedPage })),
);
const DashboardPage = lazy(() =>
  import('./pages/lister/DashboardPage').then((module) => ({ default: module.DashboardPage })),
);
const WizardPage = lazy(() =>
  import('./pages/lister/WizardPage').then((module) => ({ default: module.WizardPage })),
);
const AdminPage = lazy(() =>
  import('./pages/admin/AdminPage').then((module) => ({ default: module.AdminPage })),
);
const ModerationPage = lazy(() =>
  import('./pages/admin/ModerationPage').then((module) => ({ default: module.ModerationPage })),
);
const CoverageDemandPage = lazy(() =>
  import('./pages/admin/CoverageDemandPage').then((module) => ({
    default: module.CoverageDemandPage,
  })),
);
const FuelHealthPage = lazy(() =>
  import('./pages/admin/FuelHealthPage').then((module) => ({ default: module.FuelHealthPage })),
);
const UsersPage = lazy(() =>
  import('./pages/admin/UsersPage').then((module) => ({ default: module.UsersPage })),
);

export {
  AdminPage,
  CoverageDemandPage,
  DashboardPage,
  EnquiriesPage,
  FuelHealthPage,
  ModerationPage,
  SavedPage,
  UsersPage,
  WizardPage,
};
