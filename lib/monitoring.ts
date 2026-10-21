import { z } from 'zod';

export const CHECKS = [
  'site',
  'database',
  'notifications',
  'budget',
  'jobs',
  'backup',
  'monitor',
] as const;
export type Check = (typeof CHECKS)[number];
export const CHECK_LABELS: Record<Check, string> = {
  site: 'サイト・管理画面',
  database: 'データベース',
  notifications: 'メール通知',
  budget: 'API利用枠',
  jobs: '定期処理',
  backup: 'バックアップ',
  monitor: '外部監視の接続',
};
export const checkState = z.enum(['ok', 'failure', 'unknown', 'disabled']);
export type CheckState = z.infer<typeof checkState>;
export const monitoringSettings = z
  .object({
    revision: z.number().int().nonnegative(),
    recipient: z.union([z.literal(''), z.string().email().max(254)]),
    failureThreshold: z.number().int().min(1).max(10),
    recoveryThreshold: z.number().int().min(1).max(10),
    jobStaleMinutes: z.number().int().min(10).max(1440),
    backupStaleHours: z.number().int().min(0).max(720),
  })
  .strict();
export type MonitoringSettings = z.infer<typeof monitoringSettings>;
export const DEFAULT_MONITORING: MonitoringSettings = {
  revision: 0,
  recipient: '',
  failureThreshold: 3,
  recoveryThreshold: 2,
  jobStaleMinutes: 20,
  backupStaleHours: 0,
};
export const healthSnapshot = z
  .object({
    version: z.literal(1),
    settings: monitoringSettings,
    checks: z
      .object({
        database: checkState,
        notifications: checkState,
        budget: checkState,
        jobs: checkState,
        backup: checkState,
      })
      .strict(),
  })
  .strict();
export type HealthSnapshot = z.infer<typeof healthSnapshot>;
export const monitorEvent = z
  .object({
    id: z.string().uuid(),
    incidentId: z.string().uuid(),
    category: z.enum(CHECKS),
    transition: z.enum(['down', 'up']),
    occurredAt: z.string().datetime(),
    status: z.enum(['pending', 'accepted', 'review']),
    attempts: z.number().int().min(0).max(12),
  })
  .strict();
export type MonitorEvent = z.infer<typeof monitorEvent>;
export const monitorReport = z
  .object({
    checkedAt: z.string().datetime(),
    configRevision: z.number().int().nonnegative(),
    transport: z.enum(['ready', 'disabled', 'setup_required', 'failure']),
    events: z.array(monitorEvent).max(100),
  })
  .strict();
export type MonitorReport = z.infer<typeof monitorReport>;
