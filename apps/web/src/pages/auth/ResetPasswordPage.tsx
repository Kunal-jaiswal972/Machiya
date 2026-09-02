import { zodResolver } from '@hookform/resolvers/zod';
import { AUTH_ERROR_MESSAGES, AuthError, resetPasswordSchema } from '@machiya/shared';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { AuthShell } from '../../components/auth/AuthShell';
import { Alert, AlertDescription } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../components/ui/form';
import { Input } from '../../components/ui/input';
import { auth } from '../../lib/auth-client';

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);

  const token = searchParams.get('token') ?? '';

  const form = useForm({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { token, password: '', confirmPassword: '' },
  });

  const submit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await auth.resetPassword({ token: values.token, password: values.password });
      toast.success('Password updated. Sign in with your new one.');
      await navigate('/auth/sign-in', { replace: true });
    } catch (error) {
      const code = error instanceof AuthError ? error.code : 'unknown';
      setFormError(AUTH_ERROR_MESSAGES[code]);
    }
  });

  if (!token) {
    return (
      <AuthShell
        title="That link is incomplete"
        description="Reset links carry a token. Request a fresh one and use the newest email."
      >
        <Link
          to="/auth/forgot-password"
          className="text-sm text-primary underline underline-offset-4"
        >
          Request a new link
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" description="Then sign in with it.">
      {formError && (
        <Alert variant="destructive">
          <AlertDescription>
            {formError}{' '}
            <Link to="/auth/forgot-password" className="underline underline-offset-4">
              Request a new link
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <Form {...form}>
        <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>New password</FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    disabled={form.formState.isSubmitting}
                    {...field}
                  />
                </FormControl>
                <FormDescription>At least 10 characters.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="confirmPassword"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Confirm new password</FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    disabled={form.formState.isSubmitting}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Updating…' : 'Update password'}
          </Button>
        </form>
      </Form>
    </AuthShell>
  );
}
