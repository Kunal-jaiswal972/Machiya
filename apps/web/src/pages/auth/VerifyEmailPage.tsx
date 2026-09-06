import { AUTH_ERROR_MESSAGES, AuthError } from '@machiya/shared';
import { MailCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { AuthShell } from '../../components/auth/AuthShell';
import { Alert, AlertDescription } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { auth } from '../../lib/auth-client';
import { useAuth } from '../../lib/auth-context';

/**
 * Resend page, not a verification handler: the link in the email is consumed by
 * the API, which then redirects here or to the app. This screen exists for the
 * case where the mail never arrived or the link expired.
 */
export function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const [email, setEmail] = useState(searchParams.get('email') ?? user?.email ?? '');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const alreadyVerified = user?.emailVerified === true;

  async function resend() {
    setError(null);
    setIsSending(true);
    try {
      await auth.resendVerificationEmail({
        email,
        callbackUrl: `${window.location.origin}/`,
      });
      setSent(true);
      toast.success('Verification link sent.');
    } catch (caught) {
      const code = caught instanceof AuthError ? caught.code : 'unknown';
      setError(AUTH_ERROR_MESSAGES[code]);
    } finally {
      setIsSending(false);
    }
  }

  if (alreadyVerified) {
    return (
      <AuthShell title="Already verified" description="Your email address is confirmed.">
        <Link to="/" className="text-sm text-primary underline underline-offset-4">
          Go to the map
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Verify your email"
      description="You need to confirm your address before you can sign in."
      footer={
        <Link to="/auth/sign-in" className="text-primary underline underline-offset-4">
          Back to sign in
        </Link>
      }
    >
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {sent ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <MailCheck className="size-8 text-primary" aria-hidden />
          <p className="text-sm text-muted-foreground">
            If {email} needs confirming, a fresh link is on its way. It lasts an hour.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="verify-email">Email</Label>
            <Input
              id="verify-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={isSending}
              placeholder="you@example.com"
            />
          </div>

          <Button
            type="button"
            className="w-full"
            disabled={isSending || email.trim().length === 0}
            onClick={() => void resend()}
          >
            {isSending ? 'Sending…' : 'Send me a new link'}
          </Button>
        </div>
      )}
    </AuthShell>
  );
}
