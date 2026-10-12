import { AsyncLocalStorage } from 'async_hooks';
import { LogContext } from './types';

const asyncLocalStorage = new AsyncLocalStorage<LogContext>();

/**
 * Access or run code with correlation and context propagation.
 */
export const CorrelationContext = {
  /**
   * Run a function within a given logging context.
   */
  run<R>(context: LogContext, callback: () => R): R {
    const parentContext = asyncLocalStorage.getStore() || {};
    const merged = { ...parentContext, ...context };
    return asyncLocalStorage.run(merged, callback);
  },

  /**
   * Get the current context stored in AsyncLocalStorage.
   */
  get(): LogContext {
    return asyncLocalStorage.getStore() || {};
  },

  /**
   * Set or update individual fields in the active store if present.
   */
  setContext(partial: Partial<LogContext>): void {
    const current = asyncLocalStorage.getStore();
    if (current) {
      Object.assign(current, partial);
    }
  },
};
