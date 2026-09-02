import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-4xl font-semibold">404</p>
      <p className="text-muted-foreground">That page does not exist.</p>
      <Link to="/" className="text-primary underline underline-offset-4">
        Back to the map
      </Link>
    </div>
  );
}
