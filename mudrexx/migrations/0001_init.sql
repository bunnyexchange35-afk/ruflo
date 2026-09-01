-- MUDREXX core schema — greenfield, versioned migration.
-- One canonical identity table (users) + role column. No duplicate auth system.

-- ============================================================
-- IDENTITY / ACCESS
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  human_id          TEXT NOT NULL UNIQUE,           -- 2-5 digit human-facing ID
  email             TEXT,
  phone             TEXT,
  password_hash     TEXT NOT NULL,
  password_algo     TEXT NOT NULL DEFAULT 'PBKDF2-SHA256',
  role              TEXT NOT NULL
                    CHECK (role IN ('SUPER_ADMIN','ADMIN','USER','DEMO_VIEWER')),
  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','ACTIVE','BLOCKED','SUSPENDED')),
  full_name         TEXT NOT NULL DEFAULT '',
  first_name        TEXT NOT NULL DEFAULT '',
  last_name         TEXT NOT NULL DEFAULT '',
  package_id        TEXT,
  payment_status    TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (payment_status IN ('PENDING','SUBMITTED','UNDER_REVIEW','VERIFIED','REJECTED','REFUNDED','EXPIRED')),
  approval_status   TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (approval_status IN ('PENDING','APPROVED','REJECTED')),
  is_demo           INTEGER NOT NULL DEFAULT 0,
  failed_attempts   INTEGER NOT NULL DEFAULT 0,
  locked_until      INTEGER,
  password_changed_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_login_at     INTEGER,
  last_active_at    INTEGER,
  last_device_id    TEXT,
  last_ip           TEXT
);

-- §35 case-insensitive partial search over name parts / phone / human id.
CREATE INDEX IF NOT EXISTS idx_users_email      ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_phone      ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_role       ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status     ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_created    ON users(created_at);
CREATE INDEX IF NOT EXISTS idx_users_full_name  ON users(lower(full_name));
CREATE INDEX IF NOT EXISTS idx_users_first_name ON users(lower(first_name));
CREATE INDEX IF NOT EXISTS idx_users_last_name  ON users(lower(last_name));
CREATE INDEX IF NOT EXISTS idx_users_is_demo    ON users(is_demo);
CREATE INDEX IF NOT EXISTS idx_users_approval   ON users(approval_status, payment_status);

-- §12 admin profile extension (admin id == users.human_id; no second identity store)
CREATE TABLE IF NOT EXISTS admin_profiles (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  admin_id        TEXT NOT NULL UNIQUE,               -- 2-5 digit human-facing Admin ID
  business_name   TEXT NOT NULL DEFAULT '',
  last_device_label TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- §17 device/session control. Device identity is a fingerprint, NOT an IP.
CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint   TEXT NOT NULL,
  label         TEXT NOT NULL DEFAULT '',
  browser       TEXT NOT NULL DEFAULT '',
  os            TEXT NOT NULL DEFAULT '',
  ip            TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  revoked_at    INTEGER,
  UNIQUE (user_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id, revoked_at);

-- §4/§17/§53 server-side sessions. Only the hash of the token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       TEXT NOT NULL UNIQUE,
  device_id        TEXT,
  ip               TEXT,
  user_agent       TEXT NOT NULL DEFAULT '',
  browser          TEXT NOT NULL DEFAULT '',
  os               TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  revoked_at       INTEGER,
  revoked_reason   TEXT,
  is_demo          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_sessions_device  ON sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- §18 login history
CREATE TABLE IF NOT EXISTS login_history (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  email_key  TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  device_id  TEXT,
  event      TEXT NOT NULL CHECK (event IN ('LOGIN_SUCCESS','LOGIN_FAILED','LOGOUT','SESSION_REVOKED','DEVICE_RESET')),
  browser    TEXT NOT NULL DEFAULT '',
  os         TEXT NOT NULL DEFAULT '',
  ip         TEXT,
  reason     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_history_user ON login_history(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_login_history_key  ON login_history(email_key, created_at);
CREATE INDEX IF NOT EXISTS idx_login_history_ip   ON login_history(ip, created_at);

-- §19/§20 password reset requests — Chief approves/rejects
CREATE TABLE IF NOT EXISTS password_resets (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT UNIQUE,
  status        TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','APPROVED','REJECTED','USED','EXPIRED')),
  requested_at  INTEGER NOT NULL,
  expires_at    INTEGER,
  decided_at    INTEGER,
  decided_by    TEXT,
  decision_note TEXT,
  ip            TEXT,
  user_agent    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user   ON password_resets(user_id, status);
CREATE INDEX IF NOT EXISTS idx_password_resets_status ON password_resets(status, requested_at);

CREATE TABLE IF NOT EXISTS password_history (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_history_user ON password_history(user_id, created_at);

-- §21 emergency recovery: one-time challenge, server-side secret, audited, forces reset.
CREATE TABLE IF NOT EXISTS recovery_challenges (
  id           TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  code_hash    TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','CONSUMED','EXPIRED','REVOKED')),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  ip           TEXT,
  request_id   TEXT,
  rotation_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_recovery_status ON recovery_challenges(status, expires_at);

-- ============================================================
-- PACKAGES / PAYMENTS / COMMERCIAL
-- ============================================================

CREATE TABLE IF NOT EXISTS packages (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,             -- BRONZE|SILVER|GOLD|ENTREPRENEUR
  name        TEXT NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'INR',
  is_active   INTEGER NOT NULL DEFAULT 1,
  limits_json TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS package_prices (
  id          TEXT PRIMARY KEY,
  package_id  TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  period      TEXT NOT NULL CHECK (period IN ('MONTHLY','QUARTERLY','HALF_YEARLY','ANNUAL')),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency    TEXT NOT NULL DEFAULT 'INR',
  is_active   INTEGER NOT NULL DEFAULT 1,
  UNIQUE (package_id, period)
);

CREATE TABLE IF NOT EXISTS package_addons (
  id               TEXT PRIMARY KEY,
  package_id       TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('ADDITIONAL_USER','ADDITIONAL_LEAD','ADDITIONAL_MESSAGE','ADDITIONAL_STORAGE')),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  currency         TEXT NOT NULL DEFAULT 'INR'
);

-- §16 market reference -> recommendation -> Chief review -> publish (never auto-applied)
CREATE TABLE IF NOT EXISTS market_rates (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL,
  value_cents INTEGER NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'INR',
  source      TEXT NOT NULL DEFAULT '',
  observed_at INTEGER NOT NULL,
  note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_market_rates_key ON market_rates(key, observed_at);

-- §14 payment lifecycle. Admin may never approve own payment (enforced in service).
CREATE TABLE IF NOT EXISTS payments (
  id              TEXT PRIMARY KEY,
  admin_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id      TEXT REFERENCES packages(id) ON DELETE SET NULL,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency        TEXT NOT NULL DEFAULT 'INR',
  period          TEXT NOT NULL DEFAULT 'MONTHLY',
  method          TEXT NOT NULL DEFAULT '',
  reference       TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','SUBMITTED','UNDER_REVIEW','VERIFIED','REJECTED','REFUNDED','EXPIRED')),
  submitted_at    INTEGER,
  reviewed_at     INTEGER,
  reviewed_by     TEXT,
  rejection_reason TEXT,
  notes           TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_admin  ON payments(admin_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status, created_at);

CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id   TEXT REFERENCES packages(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'INR',
  status       TEXT NOT NULL DEFAULT 'PENDING',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);

CREATE TABLE IF NOT EXISTS wallets (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency     TEXT NOT NULL DEFAULT 'INR',
  balance_cents INTEGER NOT NULL DEFAULT 0,
  frozen_cents INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  UNIQUE (user_id, currency)
);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id          TEXT PRIMARY KEY,
  wallet_id   TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  delta_cents INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  ref         TEXT NOT NULL DEFAULT '',
  actor_id    TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_wallet ON wallet_ledger(wallet_id, created_at);

-- ============================================================
-- CRM — MASTER LEAD CONTROLLER (§24)
-- ============================================================

CREATE TABLE IF NOT EXISTS crm_contacts (
  id             TEXT PRIMARY KEY,
  owner_admin_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone          TEXT NOT NULL,
  phone_e164     TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  name           TEXT NOT NULL DEFAULT '',
  country        TEXT NOT NULL DEFAULT '',
  language       TEXT NOT NULL DEFAULT '',
  opted_in       INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (owner_admin_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_contacts_owner ON crm_contacts(owner_admin_id, created_at);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON crm_contacts(phone_e164);
CREATE INDEX IF NOT EXISTS idx_contacts_name  ON crm_contacts(lower(name));

CREATE TABLE IF NOT EXISTS crm_lists (
  id             TEXT PRIMARY KEY,
  owner_admin_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lists_owner ON crm_lists(owner_admin_id);

CREATE TABLE IF NOT EXISTS crm_list_members (
  list_id    TEXT NOT NULL REFERENCES crm_lists(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (list_id, contact_id)
);

-- One canonical Lead record. dedupe_key prevents duplicate lead systems/rows (§24).
CREATE TABLE IF NOT EXISTS leads (
  id             TEXT PRIMARY KEY,
  owner_admin_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id     TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
  name           TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT '',   -- WEBSITE|FORM|AI|WHATSAPP|IMPORT|API|CAMPAIGN|REFERRAL
  campaign_id    TEXT,
  stage          TEXT NOT NULL DEFAULT 'NEW',
  score          INTEGER NOT NULL DEFAULT 0,
  intent         TEXT NOT NULL DEFAULT '',
  language       TEXT NOT NULL DEFAULT '',
  country        TEXT NOT NULL DEFAULT '',
  consent        INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'OPEN',
  assigned_to    TEXT,
  dedupe_key     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (owner_admin_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_leads_owner    ON leads(owner_admin_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_score    ON leads(owner_admin_id, score);
CREATE INDEX IF NOT EXISTS idx_leads_stage    ON leads(owner_admin_id, stage);
CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_leads_name     ON leads(lower(name));

CREATE TABLE IF NOT EXISTS lead_activities (
  id          TEXT PRIMARY KEY,
  lead_id     TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('USER','AI','SYSTEM')),
  actor_id    TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_activities ON lead_activities(lead_id, created_at);

-- ============================================================
-- TASKS (§34, §36, §37)
-- ============================================================

CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  owner_admin_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  priority         TEXT NOT NULL DEFAULT 'MEDIUM'
                     CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  due_at           INTEGER,
  assigned_user_id TEXT,
  assigned_name    TEXT NOT NULL DEFAULT '',
  assigned_phone   TEXT NOT NULL DEFAULT '',
  category         TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'OPEN'
                     CHECK (status IN ('OPEN','IN_PROGRESS','DONE','CANCELLED')),
  source           TEXT NOT NULL DEFAULT 'MANUAL'
                     CHECK (source IN ('MANUAL','AI','AUTOMATION','SYSTEM')),
  tags             TEXT NOT NULL DEFAULT '',
  notes            TEXT NOT NULL DEFAULT '',
  dedupe_key       TEXT NOT NULL,
  created_by       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (owner_admin_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_tasks_owner     ON tasks(owner_admin_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned  ON tasks(assigned_user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due       ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status    ON tasks(owner_admin_id, status);

-- ============================================================
-- WHATSAPP (§31) — real provider, real delivery status
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id             TEXT PRIMARY KEY,
  owner_admin_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  language       TEXT NOT NULL DEFAULT 'en',
  body           TEXT NOT NULL,
  variables_json TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'DRAFT',
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_templates_owner_name ON whatsapp_templates(owner_admin_id, name);

CREATE TABLE IF NOT EXISTS whatsapp_campaigns (
  id                   TEXT PRIMARY KEY,
  owner_admin_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  template_id          TEXT REFERENCES whatsapp_templates(id) ON DELETE SET NULL,
  list_id              TEXT REFERENCES crm_lists(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'DRAFT'
                         CHECK (status IN ('DRAFT','QUEUED','RUNNING','PAUSED','COMPLETED','FAILED')),
  rate_limit_per_min   INTEGER NOT NULL DEFAULT 60,
  created_at           INTEGER NOT NULL,
  started_at           INTEGER,
  completed_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wa_campaigns_owner ON whatsapp_campaigns(owner_admin_id, created_at);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id                  TEXT PRIMARY KEY,
  campaign_id         TEXT REFERENCES whatsapp_campaigns(id) ON DELETE SET NULL,
  owner_admin_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id          TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
  to_phone            TEXT NOT NULL,
  body                TEXT NOT NULL,
  provider            TEXT NOT NULL DEFAULT '',
  provider_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'QUEUED'
                        CHECK (status IN ('QUEUED','SENT','DELIVERED','READ','FAILED','REJECTED')),
  error               TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_messages_campaign ON whatsapp_messages(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_wa_messages_owner    ON whatsapp_messages(owner_admin_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wa_messages_status   ON whatsapp_messages(status, created_at);

-- ============================================================
-- DESTINATIONS / ROUTING (§32, §33)
-- ============================================================

-- Secrets are NEVER stored here: secret_ref names a Worker secret.
CREATE TABLE IF NOT EXISTS destinations (
  id             TEXT PRIMARY KEY,
  owner_admin_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('TELEGRAM','WEBHOOK')),
  name           TEXT NOT NULL,
  secret_ref     TEXT NOT NULL DEFAULT '',
  config_json    TEXT NOT NULL DEFAULT '{}',
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_destinations_owner ON destinations(owner_admin_id, is_active);

CREATE TABLE IF NOT EXISTS routing_rules (
  id                TEXT PRIMARY KEY,
  owner_admin_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  destination_id    TEXT NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  min_score         INTEGER NOT NULL DEFAULT 0,
  intent            TEXT NOT NULL DEFAULT '',
  campaign_id       TEXT,
  language          TEXT NOT NULL DEFAULT '',
  country           TEXT NOT NULL DEFAULT '',
  source            TEXT NOT NULL DEFAULT '',
  stage             TEXT NOT NULL DEFAULT '',
  requires_consent  INTEGER NOT NULL DEFAULT 1,
  priority          INTEGER NOT NULL DEFAULT 100,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routing_owner ON routing_rules(owner_admin_id, is_active, priority);

-- dedupe_key guarantees no duplicate pushes (§32)
CREATE TABLE IF NOT EXISTS deliveries (
  id            TEXT PRIMARY KEY,
  rule_id       TEXT NOT NULL REFERENCES routing_rules(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  lead_id       TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  dedupe_key    TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_lead ON deliveries(lead_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_rule ON deliveries(rule_id, status);

-- ============================================================
-- AI (§25-§30)
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  skill_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_conv_user ON ai_conversations(user_id, updated_at);

CREATE TABLE IF NOT EXISTS ai_messages (
  id            TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('USER','ASSISTANT','SYSTEM','TOOL')),
  content       TEXT NOT NULL,
  provider      TEXT NOT NULL DEFAULT '',
  model         TEXT NOT NULL DEFAULT '',
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_msg_conv ON ai_messages(conversation_id, created_at);

-- §30 write actions require explicit confirmation before execution
CREATE TABLE IF NOT EXISTS ai_tool_calls (
  id                   TEXT PRIMARY KEY,
  conversation_id      TEXT REFERENCES ai_conversations(id) ON DELETE CASCADE,
  actor_user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool                 TEXT NOT NULL,
  args_json            TEXT NOT NULL DEFAULT '{}',
  result_json          TEXT,
  side_effect          TEXT NOT NULL CHECK (side_effect IN ('READ','WRITE')),
  status               TEXT NOT NULL DEFAULT 'PROPOSED'
                         CHECK (status IN ('PROPOSED','APPROVED','REJECTED','EXECUTED','FAILED','DENIED')),
  requires_confirmation INTEGER NOT NULL DEFAULT 0,
  denial_reason        TEXT,
  created_at           INTEGER NOT NULL,
  decided_at           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ai_tools_actor  ON ai_tool_calls(actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_tools_status ON ai_tool_calls(status, created_at);

CREATE TABLE IF NOT EXISTS ai_usage (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  cost_micros  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage(user_id, created_at);

-- §28 skills loaded dynamically (awesome-llm-apps style role catalog)
CREATE TABLE IF NOT EXISTS ai_skills (
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL,
  tools_json    TEXT NOT NULL DEFAULT '[]',
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

-- ============================================================
-- CROSS-CUTTING: AUDIT / SETTINGS / RATE LIMITS / WEBHOOKS
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT,
  actor_role  TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id   TEXT NOT NULL DEFAULT '',
  ip          TEXT,
  user_agent  TEXT NOT NULL DEFAULT '',
  request_id  TEXT NOT NULL DEFAULT '',
  meta_json   TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_log(actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id);

-- §40 portal configuration lives in the DB, not hardcoded across files
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key   TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  event_type   TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  signature_ok INTEGER NOT NULL DEFAULT 0,
  processed_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_provider ON webhook_events(provider, created_at);

CREATE TABLE IF NOT EXISTS support_tickets (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'OPEN'
                 CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED','CLOSED')),
  priority     TEXT NOT NULL DEFAULT 'MEDIUM',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_user ON support_tickets(user_id, created_at);

CREATE TABLE IF NOT EXISTS invoices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_id   TEXT REFERENCES payments(id) ON DELETE SET NULL,
  number       TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'INR',
  status       TEXT NOT NULL DEFAULT 'DRAFT',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id, created_at);

CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  owner_admin_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL,
  storage_ref  TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_admin_id, created_at);
