import { ShieldAlert } from 'lucide-react';
import { Link } from 'react-router';

export function ForbiddenPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <ShieldAlert className="size-8 text-muted-foreground" aria-hidden />
      <p className="text-lg font-semibold">Not your area</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Your account does not have access to this page. If you meant to list a property, publish
        your first listing and this opens up.
      </p>
      <Link to="/" className="text-primary underline underline-offset-4">
        Back to the map
      </Link>
    </div>
  );
}
