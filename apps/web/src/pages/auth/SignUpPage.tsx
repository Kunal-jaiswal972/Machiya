import { zodResolver } from '@hookform/resolvers/zod';
import { AUTH_ERROR_MESSAGES, AuthError, signUpSchema } from '@machiya/shared';
import { MailCheck } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { AuthShell } from '../../components/auth/AuthShell';
import { SocialButtons } from '../../components/auth/SocialButtons';
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

export function SignUpPage() {
  const [formError, setFormError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const form = useForm({
    resolver: zodResolver(signUpSchema),
    defaultValues: { name: '', email: '', password: '' },
  });

  const submit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await auth.signUpWithEmail(values);
      setSentTo(values.email);
    } catch (error) {
      const code = error instanceof AuthError ? error.code : 'unknown';
      setFormError(AUTH_ERROR_MESSAGES[code]);
    }
  });

  if (sentTo) {
    return (
      <AuthShell title="Check your inbox" description={`We sent a verification link to ${sentTo}.`}>
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <MailCheck className="size-8 text-primary" aria-hidden />
          <p className="text-sm text-muted-foreground">
            The link is valid for an hour. You need to use it before you can sign in.
          </p>
          <Link
            to={`/auth/verify-email?email=${encodeURIComponent(sentTo)}`}
            className="text-sm text-primary underline underline-offset-4"
          >
            Did not get it?
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create an account"
      description="Save offices, favourite listings, and list your own place."
      footer={
        <>
          Already have one?{' '}
          <Link to="/auth/sign-in" className="text-primary underline underline-offset-4">
            Sign in
          </Link>
        </>
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
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input autoComplete="name" disabled={form.formState.isSubmitting} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

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
                <FormLabel>Password</FormLabel>
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

          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Creating your account…' : 'Create account'}
          </Button>
        </form>
      </Form>

      <SocialButtons />
    </AuthShell>
  );
}
