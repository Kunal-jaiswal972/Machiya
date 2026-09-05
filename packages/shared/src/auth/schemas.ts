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

/**
 * A phone number as an Indian seeker or lister actually types it.
 *
 * Ten digits, optionally with +91 and any mix of spaces and dashes, normalised
 * to `+91XXXXXXXXXX` on the way in so the masking rule in D69 and the "same
 * number twice" check have one form to compare.
 */
export const phoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^(?:\+91)?[6-9]\d{9}$/, 'That does not look like a mobile number'))
  .transform((value) => (value.startsWith('+91') ? value : `+91${value}`));

/**
 * The same number as a form field, where empty means "I would rather not".
 *
 * Its own schema rather than `phoneSchema.or(z.literal(''))`, because a union
 * reports the branch that failed first and the message a person sees becomes
 * `Invalid input: expected ""` — a complaint about the empty case for someone
 * who typed a number.
 */
export const phoneFieldSchema = z
  .string()
  .trim()
  .refine(
    (value) => value === '' || phoneSchema.safeParse(value).success,
    'That does not look like a mobile number',
  )
  .transform((value) => (value === '' ? '' : phoneSchema.parse(value)));

export const profileUpdateSchema = z.object({
  name: z.string().trim().min(2, 'Tell us your name').max(80).optional(),
  /** Null clears it; the field is optional, so absent means "leave it alone". */
  phone: phoneSchema.nullable().optional(),
});

export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

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
