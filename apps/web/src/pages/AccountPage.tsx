import { useAuth } from '../lib/auth-context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';

/**
 * Minimal signed-in page, here to make the guard chain visible end to end.
 * Favourites, saved searches and the lister dashboard land in later steps.
 */
export function AccountPage() {
  const { user } = useAuth();

  if (!user) return null;

  const rows: Array<[string, string]> = [
    ['Name', user.name],
    ['Email', user.email],
    ['Email verified', user.emailVerified ? 'yes' : 'no'],
    ['Role', user.role.toLowerCase()],
    ['Phone', user.phone ?? 'not set'],
  ];

  return (
    <div className="mx-auto max-w-lg px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>Your account</CardTitle>
          <CardDescription>What the server knows about this session.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 py-2 text-sm">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
