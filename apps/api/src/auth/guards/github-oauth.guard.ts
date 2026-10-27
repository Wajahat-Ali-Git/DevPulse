import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticationException } from '../../common/errors';

/**
 * Known error codes GitHub sends on the OAuth callback when the user denies
 * access or a configuration problem exists.
 */
const GITHUB_OAUTH_ERRORS: Record<string, string> = {
  access_denied:
    'GitHub authorization was denied. Please try again and grant the required permissions.',
  redirect_uri_mismatch:
    'OAuth redirect URI mismatch. Please contact support.',
  incorrect_client_credentials:
    'Invalid OAuth application credentials. Please contact support.',
  application_suspended:
    'The OAuth application has been suspended. Please contact support.',
};

/**
 * Guard for the GitHub OAuth callback endpoint.
 *
 * Responsibilities:
 *  - Detects GitHub-originated errors (`?error=...`) and maps them to
 *    human-readable messages before they reach the controller.
 *  - Ensures `code` is present and non-empty.
 *  - Ensures `state` is present, non-empty, and contains only safe characters
 *    (hex digits — matching our 48-char hex generation format) to reject
 *    trivially malformed or injected state values early.
 *
 * CSRF state *cryptographic* validation (Redis lookup) is performed inside
 * GitHubOAuthService.handleCallback so it runs after the guard clears.
 */
@Injectable()
export class GitHubOAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const {
      code,
      state,
      error,
      error_description,
      error_uri,
    } = request.query as Record<string, string | undefined>;

    // ── 1. Handle GitHub-originated errors ─────────────────────────────────
    if (error) {
      const knownMessage = GITHUB_OAUTH_ERRORS[error];
      if (knownMessage) {
        throw new AuthenticationException(knownMessage);
      }

      // Unknown error — decode the description defensively
      let description = 'GitHub OAuth authorization failed.';
      if (error_description) {
        try {
          description = decodeURIComponent(error_description.replace(/\+/g, ' '));
        } catch {
          // Malformed encoding — fall back to the raw value, truncated for safety
          description = String(error_description).slice(0, 200);
        }
      }

      throw new AuthenticationException(description);
    }

    // ── 2. Require authorization code ──────────────────────────────────────
    if (!code || !code.trim()) {
      throw new AuthenticationException(
        'Missing authorization code from GitHub OAuth callback',
      );
    }

    // ── 3. Require state parameter ─────────────────────────────────────────
    if (!state || !state.trim()) {
      throw new AuthenticationException(
        'Missing state parameter from GitHub OAuth callback',
      );
    }

    // ── 4. Validate state format — must be a 48-char lowercase hex string ──
    // This rejects obviously tampered values before the Redis lookup.
    if (!/^[0-9a-f]{48}$/.test(state)) {
      throw new AuthenticationException(
        'Malformed OAuth state parameter. Possible CSRF attack detected.',
      );
    }

    return true;
  }
}
