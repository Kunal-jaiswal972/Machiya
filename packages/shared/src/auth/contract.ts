import type { SessionUser, SocialProvider } from './schemas.js';

/**
 * What the app needs from an auth provider, and nothing more.
 *
 * Better Auth is the implementation (apps/api/src/auth for the server,
 * apps/web/src/lib/auth-client.ts for the browser). Feature code depends on
 * this shape rather than on Better Auth directly, so swapping providers means
 * rewriting those two adapter files and nothing else. Keep this interface free
 * of provider vocabulary — no `betterFetch`, no plugin types, no cookies.
 */
export interface AuthSession {
  user: SessionUser;
  expiresAt: Date;
}

export interface AuthClientContract {
  signUpWithEmail(input: {
    name: string;
    email: string;
    password: string;
  }): Promise<{ requiresVerification: boolean }>;

  signInWithEmail(input: { email: string; password: string; rememberMe?: boolean }): Promise<void>;

  signInWithSocial(provider: SocialProvider, callbackUrl: string): Promise<void>;

  signOut(): Promise<void>;

  requestPasswordReset(input: { email: string; redirectTo: string }): Promise<void>;

  resetPassword(input: { token: string; password: string }): Promise<void>;

  resendVerificationEmail(input: { email: string; callbackUrl: string }): Promise<void>;
}

/** Paths the browser hits. Mounted by the API under this base. */
export const AUTH_BASE_PATH = '/api/auth';

/**
 * Error codes the UI translates into copy. Provider-specific codes are mapped
 * onto these in the adapter, so screens never switch on a vendor string.
 */
export const AUTH_ERROR_CODES = {
  invalidCredentials: 'invalid_credentials',
  emailNotVerified: 'email_not_verified',
  emailTaken: 'email_taken',
  userBanned: 'user_banned',
  rateLimited: 'rate_limited',
  invalidToken: 'invalid_token',
  unknown: 'unknown',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  invalid_credentials: 'That email and password combination did not work.',
  email_not_verified: 'Verify your email address first — check your inbox.',
  email_taken: 'An account already exists for that email.',
  user_banned: 'This account has been suspended.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  invalid_token: 'That link has expired or has already been used.',
  unknown: 'Something went wrong. Try again.',
};
