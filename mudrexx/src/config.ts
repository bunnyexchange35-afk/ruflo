/** Central, reviewable operational constants. No hardcoded credentials anywhere. */

export const SESSION_TTL_MS: Record<string, number> = {
  SUPER_ADMIN: 8 * 60 * 60 * 1000, // 8h  — highest privilege, shortest session
  ADMIN: 12 * 60 * 60 * 1000, // 12h
  USER: 30 * 24 * 60 * 60 * 1000, // 30d
  DEMO_VIEWER: 12 * 60 * 60 * 1000, // 12h
};

export const SESSION_COOKIE = 'mudrexx_session';
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // re-touch cadence

/** §20 login attempt protection */
export const MAX_FAILED_ATTEMPTS = 5;
export const ACCOUNT_LOCK_MS = 15 * 60 * 1000;
export const LOGIN_RATE_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };

/** §19/§20 reset tokens: random, short-lived, single-use, revocable */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h once Chief approves
export const RESET_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_HISTORY_COUNT = 5;
export const PASSWORD_MIN_LENGTH = 10;

/** §21 emergency recovery: time-limited, rate-limited, one-time */
export const RECOVERY_TTL_MS = 10 * 60 * 1000;
export const RECOVERY_RATE_LIMIT = { limit: 3, windowMs: 60 * 60 * 1000 };

/** §49 rate limits per bucket */
export const RATE_LIMITS = {
  AI_CHAT: { limit: 60, windowMs: 60 * 1000 },
  WEBHOOK: { limit: 300, windowMs: 60 * 1000 },
  BULK_MESSAGE: { limit: 20, windowMs: 60 * 1000 },
  PUBLIC_TRACKING: { limit: 60, windowMs: 60 * 1000 },
  REGISTER: { limit: 5, windowMs: 60 * 60 * 1000 },
  PASSWORD_RESET: { limit: 5, windowMs: 60 * 60 * 1000 },
} as const;

/** §50 pagination guards — no unbounded queries reach the browser */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 25;

export const API_PREFIX = '/api';
