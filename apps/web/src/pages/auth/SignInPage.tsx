import { zodResolver } from '@hookform/resolvers/zod';
import { AUTH_ERROR_MESSAGES, AuthError, signInSchema } from '@machiya/shared';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router';
import { AuthShell } from '../../components/auth/AuthShell';
import { SocialButtons } from '../../components/auth/SocialButtons';
import { Alert, AlertDescription } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../components/ui/form';
import { Input } from '../../components/ui/input';
import { auth } from '../../lib/auth-client';

export function SignInPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [formError, setFormError] = useState<string | null>(null);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const form = useForm({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: '', password: '', rememberMe: true },
  });

  const submit = form.handleSubmit(async (values) => {
    setFormError(null);
    setUnverifiedEmail(null);

    try {
      await auth.signInWithEmail(values);
      await navigate(from, { replace: true });
    } catch (error) {
      const code = error instanceof AuthError ? error.code : 'unknown';
      setFormError(AUTH_ERROR_MESSAGES[code]);
      if (code === 'email_not_verified') {
        setUnverifiedEmail(values.email);
      }
    }
  });

  return (
    <AuthShell
      title="Sign in"
      description="Find rentals near your office, priced with the commute."
      footer={
        <>
          New here?{' '}
          <Link to="/auth/sign-up" className="text-primary underline underline-offset-4">
            Create an account
          </Link>
        </>
      }
    >
      {formError && (
        <Alert variant="destructive">
          <AlertDescription>
            {formError}
            {unverifiedEmail && (
              <>
                {' '}
                <Link
                  to={`/auth/verify-email?email=${encodeURIComponent(unverifiedEmail)}`}
                  className="underline underline-offset-4"
                >
                  Resend the link
                </Link>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      <Form {...form}>
        <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    disabled={form.formState.isSubmitting}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center justify-between">
                  <FormLabel>Password</FormLabel>
                  <Link
                    to="/auth/forgot-password"
                    className="text-xs text-muted-foreground underline underline-offset-4"
                  >
                    Forgot it?
                  </Link>
                </div>
                <FormControl>
                  <Input
                    type="password"
                    autoComplete="current-password"
                    disabled={form.formState.isSubmitting}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="rememberMe"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center gap-2">
                <FormControl>
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={(checked) => field.onChange(checked === true)}
                    disabled={form.formState.isSubmitting}
                  />
                </FormControl>
                <FormLabel className="text-sm font-normal">Keep me signed in</FormLabel>
              </FormItem>
            )}
          />

          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Form>

      <SocialButtons callbackUrl={from} />
    </AuthShell>
  );
}
