import { z } from 'zod';
import { userRoleSchema } from '../enums.js';

/**
 * Password policy. Long enough to matter, no character-class theatre — length
 * is what actually helps, and arbitrary symbol rules push people to `Passw0rd!`.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128, 'That is longer than 128 characters');

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

export const signUpSchema = z.object({
  name: z.string().trim().min(2, 'Tell us your name').max(80),
  email: emailSchema,
  password: passwordSchema,
});

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password'),
  rememberMe: z.boolean().default(true),
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1),
    password: passwordSchema,
    confirmPassword: z.string().min(1),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'Those passwords do not match',
    path: ['confirmPassword'],
  });

export type SignUpInput = z.infer<typeof signUpSchema>;
export type SignInInput = z.infer<typeof signInSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/** The subset of the session the app actually reads. */
export const sessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
  role: userRoleSchema,
  avatarUrl: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  isPhoneVerified: z.boolean().optional(),
  banned: z.boolean().nullable().optional(),
});

export type SessionUser = z.infer<typeof sessionUserSchema>;

export const socialProviderSchema = z.enum(['google', 'github']);
export type SocialProvider = z.infer<typeof socialProviderSchema>;

/** Providers the deployment has switched on, parsed from AUTH_ENABLED_PROVIDERS. */
export const enabledProvidersSchema = z
  .string()
  .default('email')
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0),
  )
  .pipe(z.array(z.enum(['email', 'google', 'github'])).nonempty());
