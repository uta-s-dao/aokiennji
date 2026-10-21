import { runMonitor, resendSender } from './monitor-core';

// Deliberately do not load .env.local: the independent host has its own environment file.
async function main() {
  process.umask(0o077);
  const sender =
    process.env.MONITOR_EMAIL_MODE === 'live'
      ? resendSender({
          key: process.env.MONITOR_RESEND_API_KEY || '',
          from: process.env.MONITOR_FROM || '',
          domainId: process.env.MONITOR_RESEND_DOMAIN_ID || '',
        })
      : null;
  const result = await runMonitor(
    {
      origin: process.env.MONITOR_ORIGIN || '',
      secret: process.env.MONITOR_SECRET || '',
      statePath: process.env.MONITOR_STATE_PATH || '',
      bootstrapRecipient: process.env.MONITOR_BOOTSTRAP_TO,
      allowLoopback: process.env.MONITOR_ALLOW_LOOPBACK === 'true',
    },
    sender,
  );
  console.log(JSON.stringify(result));
  if (result.transport && ['failure', 'setup_required'].includes(result.transport))
    process.exitCode = 1;
}
main().catch(() => {
  console.error('External monitor failed; inspect the independent host configuration and state.');
  process.exitCode = 1;
});
