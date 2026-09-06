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
      /*
        The server answers the same way whether or not the address already has
        an account — deliberately, so nobody can use sign-up to find out who is
        registered here. That makes "we sent you a link" a promise the screen
        cannot keep, and someone with an existing account waits for a mail that
        will never arrive. So the copy covers both cases and offers the way out
        of each.
      */
      <AuthShell
        title="Check your inbox"
        description={`If ${sentTo} is new here, a link is on its way.`}
      >
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <MailCheck className="size-8 text-primary" aria-hidden />
          <p className="text-sm text-muted-foreground">
            The link lasts an hour, and you need it before you can sign in.
          </p>
          <p className="text-sm text-muted-foreground">
            Already had an account with this address?{' '}
            <Link to="/auth/sign-in" className="text-primary underline underline-offset-4">
              Sign in instead
            </Link>
            .
          </p>
          <Link
            to={`/auth/verify-email?email=${encodeURIComponent(sentTo)}`}
            className="text-sm text-primary underline underline-offset-4"
          >
            Nothing arrived?
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
