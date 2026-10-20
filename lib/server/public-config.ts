import { getSettings, demoMode } from '@/lib/server/db';
import type { PublicConfig } from '@/lib/contracts';
export function getPublicConfig(): PublicConfig {
  const settings = getSettings();
  return { flags: settings.flags, demoMode: demoMode(), welcomeMessage: settings.welcomeMessage };
}
