/* Workers runtime types (D1Database, Fetcher, ...) are ambient globals — do not import. */

/** Canonical RBAC roles (§22). */
export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'USER', 'DEMO_VIEWER'] as const;
export type Role = (typeof ROLES)[number];

/** Role hierarchy — higher number = more authority (§3). */
export const ROLE_RANK: Record<Role, number> = {
  SUPER_ADMIN: 3,
  ADMIN: 2,
  USER: 1,
  DEMO_VIEWER: 0,
};

/** User-facing portal names (§3). */
export const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Chief Admin',
  ADMIN: 'Admin',
  USER: 'User',
  DEMO_VIEWER: 'Demo',
};

export interface UserRow {
  id: string;
  human_id: string;
  email: string | null;
  phone: string | null;
  password_hash: string;
  password_algo: string;
  role: Role;
  status: 'PENDING' | 'ACTIVE' | 'BLOCKED' | 'SUSPENDED';
  full_name: string;
  first_name: string;
  last_name: string;
  package_id: string | null;
  payment_status: PaymentStatus;
  approval_status: ApprovalStatus;
  is_demo: number;
  failed_attempts: number;
  locked_until: number | null;
  password_changed_at: number | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
  last_active_at: number | null;
  last_device_id: string | null;
  last_ip: string | null;
}

export type PaymentStatus =
  | 'PENDING'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'VERIFIED'
  | 'REJECTED'
  | 'REFUNDED'
  | 'EXPIRED';

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export const PAYMENT_STATUSES: PaymentStatus[] = [
  'PENDING',
  'SUBMITTED',
  'UNDER_REVIEW',
  'VERIFIED',
  'REJECTED',
  'REFUNDED',
  'EXPIRED',
];

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  device_id: string | null;
  ip: string | null;
  user_agent: string;
  browser: string;
  os: string;
  created_at: number;
  last_activity_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoked_reason: string | null;
  is_demo: number;
}

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  /** deployment environment name: production | staging | preview | test */
  ENVIRONMENT?: string;
  /** comma-separated CORS allowlist for /api/* (no wildcard when credentials are used) */
  ALLOWED_ORIGINS?: string;

  /* ---------------- server-side secrets (never sent to the browser) ------- */
  /** §21 emergency recovery secret. Rotatable. Required to mint recovery codes. */
  RECOVERY_SECRET?: string;
  /** Rotation id lets an operator invalidate every challenge minted before a rotation. */
  RECOVERY_ROTATION_ID?: string;

  /* ---------------- LLM providers (§27) ---------------------------------- */
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  GOOGLE_API_KEY?: string;
  GOOGLE_MODEL?: string;
  OLLAMA_BASE_URL?: string;
  OLLAMA_MODEL?: string;
  /** comma-ordered provider fallback chain, e.g. "openai,anthropic,openrouter" */
  LLM_PROVIDER_ORDER?: string;
  LLM_DEFAULT_PROVIDER?: string;

  /* ---------------- WhatsApp provider (§31) ------------------------------ */
  /** meta_cloud_api | wati | twilio | interakt */
  WHATSAPP_PROVIDER?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_API_VERSION?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_WHATSAPP_FROM?: string;
  WHATSAPP_WEBHOOK_SECRET?: string;

  /* ---------------- Telegram / destinations (§32) ------------------------ */
  /** Bot token is a Worker secret. Destinations reference it by name only. */
  TELEGRAM_BOT_TOKEN?: string;
  WEBHOOK_DELIVERY_SECRET?: string;
}

/** Per-request auth context attached by the session middleware. */
export interface AuthContext {
  user: UserRow;
  session: SessionRow;
  requestId: string;
  ip: string;
  userAgent: string;
}

export interface PortalSettings {
  portalName: string;
  portalShortName: string;
  browserTitle: string;
  loginTitle: string;
  dashboardTitle: string;
  footer: string;
}

export const DEFAULT_PORTAL_SETTINGS: PortalSettings = {
  portalName: 'MUDREXX',
  portalShortName: 'MUDREXX',
  browserTitle: 'MUDREXX Platform',
  loginTitle: 'Sign in to MUDREXX',
  dashboardTitle: 'Dashboard',
  footer: 'MUDREXX — All rights reserved',
};
