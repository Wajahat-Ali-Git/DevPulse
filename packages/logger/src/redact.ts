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
];

export const REDACTED_VALUE = '[REDACTED]';

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

  // Handle strings that might contain sensitive headers (e.g., "Bearer eyJhbGci...")
  if (typeof data === 'string') {
    // Redact Bearer tokens in strings
    return data.replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, `$1${REDACTED_VALUE}`) as unknown as T;
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
      message: data.message,
      stack: data.stack,
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
