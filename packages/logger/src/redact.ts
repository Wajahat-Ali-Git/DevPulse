/**
 * Default list of sensitive keys to redact from log objects and metadata.
 */
export const DEFAULT_SENSITIVE_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'authorization',
  'auth',
  'api_key',
  'apikey',
  'client_secret',
  'clientsecret',
  'session_secret',
  'encryption_key',
  'jwt_secret',
  'cookie',
  'set-cookie',
  'private_key',
  'privatekey',
  'webhook_secret',
  'credit_card',
  'cardnumber',
  'cvv',
  'ssn',
  'sensitive',
  'credential',
  'credentials',
  'id_token',
  'idtoken',
  'code_verifier',
  'codeverifier',
  'cert',
  'certificate',
  'session_id',
  'sessionid',
  'xsrf_token',
  'xsrftoken',
  'csrf_token',
  'csrftoken',
];

export const REDACTED_VALUE = '[REDACTED]';

/**
 * Common string patterns that match credentials, tokens, secrets, or sensitive headers
 * embedded inside error messages, log lines, URL queries, or plain strings.
 */
const STRING_CREDENTIAL_PATTERNS: Array<{ regex: RegExp; replace: (match: string, ...args: any[]) => string }> = [
  // Bearer tokens (e.g. "Bearer eyJ...", "Bearer abc123...")
  {
    regex: /(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
    replace: (_m, p1) => `${p1}${REDACTED_VALUE}`,
  },
  // Basic auth header (e.g. "Basic dXNlcjpwYXNz")
  {
    regex: /(Basic\s+)[A-Za-z0-9+/]+=*/gi,
    replace: (_m, p1) => `${p1}${REDACTED_VALUE}`,
  },
  // GitHub Personal Access Tokens and OAuth tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  {
    regex: /\b(gh[pousr]_[A-Za-z0-9_]{16,255})\b/g,
    replace: () => REDACTED_VALUE,
  },
  // GitHub Fine-grained Personal Access Tokens (github_pat_...)
  {
    regex: /\b(github_pat_[A-Za-z0-9_]{22,255})\b/g,
    replace: () => REDACTED_VALUE,
  },
  // JSON Web Tokens (header.payload.signature)
  {
    regex: /\b(ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
    replace: () => REDACTED_VALUE,
  },
  // Versioned token envelopes (e.g. "v1:<iv>:<tag>:<ciphertext>")
  {
    regex: /\bv1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+\b/gi,
    replace: () => REDACTED_VALUE,
  },
  // Database connection strings containing passwords (e.g. postgres://user:password@host:port/db)
  {
    regex: /((?:postgres(?:ql)?|mysql|redis(?:s)?|mongodb(?:\+srv)?):\/\/[^:\s]+:)([^@\s]+)(@)/gi,
    replace: (_m, p1, _pass, p3) => `${p1}${REDACTED_VALUE}${p3}`,
  },
  // URL query parameter credentials (e.g. ?access_token=xyz, &token=xyz, &client_secret=xyz, &password=xyz)
  {
    regex: /([?&](?:access_token|refresh_token|token|api_key|apikey|secret|client_secret|password|code)=)([^&\s#]+)/gi,
    replace: (_m, p1) => `${p1}${REDACTED_VALUE}`,
  },
  // Key-value pairs in logs/messages: password=xxx, token: "xxx", secret='xxx'
  {
    regex: /((?:password|passwd|secret|token|access_token|refresh_token|api_key|client_secret)\s*[:=]\s*["']?)([^"'&\s,;]{3,})(["']?)/gi,
    replace: (_m, p1, _val, p3) => `${p1}${REDACTED_VALUE}${p3}`,
  },
];

/**
 * Sanitizes any string (such as an error message or log string) by masking credentials.
 */
export function redactCredentialString(str: string): string {
  if (!str || typeof str !== 'string') {
    return str;
  }
  let result = str;
  for (const { regex, replace } of STRING_CREDENTIAL_PATTERNS) {
    result = result.replace(regex, replace as any);
  }
  return result;
}

/**
 * Checks if a key matches any sensitive pattern.
 */
function isSensitiveKey(key: string, sensitiveKeys: Set<string>): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  for (const item of sensitiveKeys) {
    const cleanItem = item.toLowerCase().replace(/[-_]/g, '');
    if (normalized === cleanItem || normalized.includes(cleanItem)) {
      return true;
    }
  }
  return false;
}

/**
 * Recursively redacts sensitive values from an object, array, or primitive.
 * Safely handles circular references and complex types.
 */
export function redactSensitiveData<T>(
  data: T,
  customSensitiveKeys?: string[],
  seen = new WeakSet<object>()
): T {
  if (data === null || data === undefined) {
    return data;
  }

  // Handle strings that might contain credentials, tokens, or connection strings
  if (typeof data === 'string') {
    return redactCredentialString(data) as unknown as T;
  }

  if (typeof data !== 'object') {
    return data;
  }

  // Handle circular references
  if (seen.has(data as object)) {
    return '[Circular]' as unknown as T;
  }
  seen.add(data as object);

  // Handle Error instances
  if (data instanceof Error) {
    const errorCopy: Record<string, unknown> = {
      name: data.name,
      message: redactSensitiveData(data.message, customSensitiveKeys, seen),
      stack: redactSensitiveData(data.stack, customSensitiveKeys, seen),
    };
    for (const key of Object.getOwnPropertyNames(data)) {
      if (key !== 'name' && key !== 'message' && key !== 'stack') {
        const val = (data as unknown as Record<string, unknown>)[key];
        errorCopy[key] = redactSensitiveData(val, customSensitiveKeys, seen);
      }
    }
    return errorCopy as unknown as T;
  }

  // Handle Dates, RegExps
  if (data instanceof Date || data instanceof RegExp) {
    return data;
  }

  // Handle Arrays
  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item, customSensitiveKeys, seen)) as unknown as T;
  }

  const keysSet = new Set(
    (customSensitiveKeys ? [...DEFAULT_SENSITIVE_KEYS, ...customSensitiveKeys] : DEFAULT_SENSITIVE_KEYS).map((k) =>
      k.toLowerCase()
    )
  );

  const result: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(data)) {
    if (isSensitiveKey(key, keysSet)) {
      result[key] = REDACTED_VALUE;
    } else {
      result[key] = redactSensitiveData(val, customSensitiveKeys, seen);
    }
  }

  return result as T;
}
