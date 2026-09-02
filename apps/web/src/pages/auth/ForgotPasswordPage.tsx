import { zodResolver } from '@hookform/resolvers/zod';
import { AUTH_ERROR_MESSAGES, AuthError, forgotPasswordSchema } from '@machiya/shared';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { AuthShell } from '../../components/auth/AuthShell';
import { Alert, AlertDescription } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
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

export function ForgotPasswordPage() {
  const [formError, setFormError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const form = useForm({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  const submit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await auth.requestPasswordReset({
        email: values.email,
        redirectTo: `${window.location.origin}/auth/reset-password`,
      });
      setSubmitted(true);
    } catch (error) {
      const code = error instanceof AuthError ? error.code : 'unknown';
      setFormError(AUTH_ERROR_MESSAGES[code]);
    }
  });

  // Deliberately the same message whether or not the address exists — the form
  // must not become an account-enumeration oracle.
  if (submitted) {
    return (
      <AuthShell
        title="Check your inbox"
        description="If that address has an account, a reset link is on its way. It is valid for an hour."
      >
        <Link to="/auth/sign-in" className="text-sm text-primary underline underline-offset-4">
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      description="Tell us your email and we will send a link."
      footer={
        <Link to="/auth/sign-in" className="text-primary underline underline-offset-4">
          Back to sign in
        </Link>
      }
    >
      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
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

          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
      </Form>
    </AuthShell>
  );
}
