import { AUTH_ERROR_MESSAGES, AuthError, type SocialProvider } from '@machiya/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { env } from '../../env';
import { auth } from '../../lib/auth-client';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';

const LABELS: Record<SocialProvider, string> = {
  google: 'Continue with Google',
  github: 'Continue with GitHub',
};

/**
 * Renders only the providers this deployment enabled, so a button never leads
 * to a broken OAuth redirect.
 */
export function SocialButtons({ callbackUrl = '/' }: { callbackUrl?: string }) {
  const [pending, setPending] = useState<SocialProvider | null>(null);

  const providers = (['google', 'github'] as const).filter((provider) =>
    env.VITE_AUTH_PROVIDERS.includes(provider),
  );

  if (providers.length === 0) return null;

  async function signIn(provider: SocialProvider) {
    setPending(provider);
    try {
      await auth.signInWithSocial(provider, `${window.location.origin}${callbackUrl}`);
    } catch (error) {
      const code = error instanceof AuthError ? error.code : 'unknown';
      toast.error(AUTH_ERROR_MESSAGES[code]);
      setPending(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="text-xs text-muted-foreground">or</span>
        <Separator className="flex-1" />
      </div>

      {providers.map((provider) => (
        <Button
          key={provider}
          type="button"
          variant="outline"
          className="w-full"
          disabled={pending !== null}
          onClick={() => void signIn(provider)}
        >
          {pending === provider ? 'Redirecting…' : LABELS[provider]}
        </Button>
      ))}
    </div>
  );
}
