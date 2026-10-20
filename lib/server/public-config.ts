import { getSettings, demoMode } from '@/lib/server/db';
import type { PublicConfig } from '@/lib/contracts';
export async function getPublicConfig(): Promise<PublicConfig> {
  const settings = (await getSettings());
  return { flags: settings.flags, demoMode: demoMode(), welcomeMessage: settings.welcomeMessage };
}
