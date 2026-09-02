import {
  AUTH_BASE_PATH,
  AUTH_ERROR_CODES,
  AuthError,
  type AuthClientContract,
  type AuthErrorCode,
  type SocialProvider,
} from '@machiya/shared';
import { adminClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { env } from '../env';

/**
 * The Better Auth browser client. This file and apps/api/src/auth are the only
 * two places that know Better Auth exists — everything else in the app talks to
 * the AuthClientContract from @machiya/shared.
 */
export const authClient = createAuthClient({
  baseURL: `${env.VITE_API_BASE_URL}${AUTH_BASE_PATH}`,
  plugins: [adminClient()],
  fetchOptions: {
    // The session cookie is httpOnly and cross-origin in development.
    credentials: 'include',
  },
});

export const { useSession } = authClient;

/** Provider error strings mapped onto the app's own codes, once. */
function toAuthErrorCode(status: number | undefined, code: string | undefined): AuthErrorCode {
  switch (code) {
    case 'INVALID_EMAIL_OR_PASSWORD':
    case 'INVALID_PASSWORD':
      return AUTH_ERROR_CODES.invalidCredentials;
    case 'EMAIL_NOT_VERIFIED':
      return AUTH_ERROR_CODES.emailNotVerified;
    case 'USER_ALREADY_EXISTS':
    case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL':
      return AUTH_ERROR_CODES.emailTaken;
    case 'BANNED_USER':
      return AUTH_ERROR_CODES.userBanned;
    case 'INVALID_TOKEN':
      return AUTH_ERROR_CODES.invalidToken;
    default:
      break;
  }

  if (status === 429) return AUTH_ERROR_CODES.rateLimited;
  if (status === 401 || status === 403) return AUTH_ERROR_CODES.invalidCredentials;
  return AUTH_ERROR_CODES.unknown;
}

function assertOk(result: {
  error?: { status?: number; code?: string; message?: string } | null;
}): void {
  if (result.error) {
    throw new AuthError(
      toAuthErrorCode(result.error.status, result.error.code),
      result.error.message ?? 'Authentication failed',
    );
  }
}

export const auth: AuthClientContract = {
  async signUpWithEmail({ name, email, password }) {
    const result = await authClient.signUp.email({ name, email, password });
    assertOk(result);
    // Verification is mandatory server-side, so there is never a session yet.
    return { requiresVerification: true };
  },

  async signInWithEmail({ email, password, rememberMe = true }) {
    assertOk(await authClient.signIn.email({ email, password, rememberMe }));
  },

  async signInWithSocial(provider: SocialProvider, callbackUrl: string) {
    assertOk(await authClient.signIn.social({ provider, callbackURL: callbackUrl }));
  },

  async signOut() {
    assertOk(await authClient.signOut());
  },

  async requestPasswordReset({ email, redirectTo }) {
    // 1.7 renamed this endpoint from forgetPassword.
    assertOk(await authClient.requestPasswordReset({ email, redirectTo }));
  },

  async resetPassword({ token, password }) {
    assertOk(await authClient.resetPassword({ token, newPassword: password }));
  },

  async resendVerificationEmail({ email, callbackUrl }) {
    assertOk(await authClient.sendVerificationEmail({ email, callbackURL: callbackUrl }));
  },
};
