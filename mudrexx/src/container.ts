import { Db } from './db/client';
import type { Env } from './types';
import { UserRepository } from './repositories/users';
import { DeviceRepository, SessionRepository } from './repositories/sessions';
import {
  LoginHistoryRepository,
  PasswordHistoryRepository,
  PasswordResetRepository,
  RecoveryRepository,
} from './repositories/security';
import { PackageRepository, PaymentRepository, WalletRepository } from './repositories/commercial';
import { ContactRepository, LeadRepository } from './repositories/crm';
import { TaskRepository } from './repositories/tasks';
import {
  CampaignRepository,
  DeliveryRepository,
  DestinationRepository,
  MessageRepository as WhatsAppMessageRepository,
  RoutingRuleRepository,
  TemplateRepository,
} from './repositories/messaging';
import {
  ConversationRepository,
  MessageRepository as AiMessageRepository,
  SkillRepository,
  ToolCallRepository,
  UsageRepository,
} from './repositories/ai';
import {
  AuditRepository,
  DocumentRepository,
  InvoiceRepository,
  RateLimitRepository,
  SettingsRepository,
  SupportTicketRepository,
  WebhookEventRepository,
} from './repositories/platform';

/**
 * Composition root. Routes receive a Container instead of reaching for env.DB,
 * keeping route handlers thin (§43).
 */
export function createContainer(env: Env): Container {
  const db = new Db(env.DB);
  return {
    env,
    db,
    users: new UserRepository(db),
    sessions: new SessionRepository(db),
    devices: new DeviceRepository(db),
    loginHistory: new LoginHistoryRepository(db),
    passwordResets: new PasswordResetRepository(db),
    passwordHistory: new PasswordHistoryRepository(db),
    recovery: new RecoveryRepository(db),
    packages: new PackageRepository(db),
    payments: new PaymentRepository(db),
    wallets: new WalletRepository(db),
    contacts: new ContactRepository(db),
    leads: new LeadRepository(db),
    tasks: new TaskRepository(db),
    templates: new TemplateRepository(db),
    campaigns: new CampaignRepository(db),
    waMessages: new WhatsAppMessageRepository(db),
    destinations: new DestinationRepository(db),
    routingRules: new RoutingRuleRepository(db),
    deliveries: new DeliveryRepository(db),
    conversations: new ConversationRepository(db),
    aiMessages: new AiMessageRepository(db),
    toolCalls: new ToolCallRepository(db),
    aiUsage: new UsageRepository(db),
    skills: new SkillRepository(db),
    audit: new AuditRepository(db),
    settings: new SettingsRepository(db),
    rateLimits: new RateLimitRepository(db),
    support: new SupportTicketRepository(db),
    invoices: new InvoiceRepository(db),
    documents: new DocumentRepository(db),
    webhookEvents: new WebhookEventRepository(db),
  };
}

export type Container = {
  env: Env;
  db: Db;
  users: UserRepository;
  sessions: SessionRepository;
  devices: DeviceRepository;
  loginHistory: LoginHistoryRepository;
  passwordResets: PasswordResetRepository;
  passwordHistory: PasswordHistoryRepository;
  recovery: RecoveryRepository;
  packages: PackageRepository;
  payments: PaymentRepository;
  wallets: WalletRepository;
  contacts: ContactRepository;
  leads: LeadRepository;
  tasks: TaskRepository;
  templates: TemplateRepository;
  campaigns: CampaignRepository;
  waMessages: WhatsAppMessageRepository;
  destinations: DestinationRepository;
  routingRules: RoutingRuleRepository;
  deliveries: DeliveryRepository;
  conversations: ConversationRepository;
  aiMessages: AiMessageRepository;
  toolCalls: ToolCallRepository;
  aiUsage: UsageRepository;
  skills: SkillRepository;
  audit: AuditRepository;
  settings: SettingsRepository;
  rateLimits: RateLimitRepository;
  support: SupportTicketRepository;
  invoices: InvoiceRepository;
  documents: DocumentRepository;
  webhookEvents: WebhookEventRepository;
};
