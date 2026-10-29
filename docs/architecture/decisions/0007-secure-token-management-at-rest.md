# ADR 0007: Secure Token Management at Rest and Zero Token Leakage in API Responses

## Status
Accepted

## Date
2026-10-29

## Context
DevPulse authenticates users and integrates with third-party developer platforms (primarily GitHub OAuth 2.0). These integrations involve sensitive credentials:
- **Third-Party OAuth Tokens**: GitHub access tokens and refresh tokens conferring repository and user read access.
- **DevPulse Refresh Tokens**: Long-lived credentials used to issue short-lived JWT access tokens.
- **API Response Boundaries**: Web browser clients and external consumers communicate with DevPulse REST APIs. Exposing raw OAuth tokens or refresh tokens in API responses exposes tokens to XSS interception, browser history leakage, third-party script extraction, and audit log exposure.

Leaving credentials plaintext in PostgreSQL tables or returning tokens in JSON response bodies violates least-privilege security principles and security compliance standards.

## Decision
We implemented a multi-layered token security architecture encompassing **authenticated encryption at rest** and **zero-leakage API response contracts**:

### 1. Key Derivation & AES-256-GCM Encryption at Rest
All external OAuth access and refresh tokens stored in the database (`GitHubAccount.accessToken` and `GitHubAccount.refreshToken`) are encrypted before persisting:
- **Algorithm**: Authenticated Encryption using **AES-256-GCM** with 128-bit authentication tags to guarantee both confidentiality and integrity.
- **Key Derivation (HKDF)**: Uses HMAC-based Extract-and-Expand Key Derivation Function (`crypto.hkdfSync` with SHA-256) deriving an isolated 256-bit subkey dedicated to token encryption from `ENCRYPTION_KEY`.
- **Unique IV (Nonce)**: A cryptographically secure 12-byte random nonce is generated for every encryption operation, ensuring identical plaintext tokens produce distinct ciphertexts.
- **Envelope Format**: Versioned envelope `v1:<iv_hex>:<auth_tag_hex>:<ciphertext_hex>` allowing seamless key rotation and scheme upgrades in the future.
- **Fail-Secure Decryption**: Authenticated GCM tags ensure any tampering or corruption throws an explicit error rather than decrypting garbage.

### 2. Zero-Leakage Response Contracts & Secure Cookie Delivery
- **Never Return Tokens in API Responses**:
  - `GET /api/v1/auth/me`: Explicit database projection excludes `accessToken` and `refreshToken` fields from `githubAccounts`.
  - `POST /api/v1/auth/github/associate`: Response contains user profile and public account metadata; tokens are never serialized or returned.
  - `POST /api/v1/auth/refresh`: Returns clean JSON metadata (`success`, `tokenType`, `expiresIn`). Access and refresh tokens are securely set in `httpOnly`, `Secure`, `SameSite=Lax` cookies (`devpulse_access_token` and `devpulse_refresh_token`).
- **One-Way Hashing for Internal Refresh Tokens**:
  - Internal DevPulse refresh tokens are never stored plaintext; they are stored exclusively as one-way SHA-256 hashes (`RefreshToken.tokenHash`).

## Consequences
- **Positive**:
  - Zero exposure: Database compromises or SQL dumps do not yield plaintext GitHub credentials.
  - XSS resilience: Client scripts cannot access tokens via API response inspection or document access when using `httpOnly` cookies.
  - Automated detection and tampering resistance via authenticated GCM tags.
  - Backward compatibility: Graceful handling of null/empty tokens and versioned format tags.
- **Negative**:
  - Encrypted tokens cannot be queried directly via database equality searches (must search on foreign key / `githubUserId` / `userId`).
