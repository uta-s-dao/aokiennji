# Vercel preview and production readiness

## UI improvement preview

Current UI review URL: <https://aokienji-ui-preview.vercel.app>

This is a separate Vercel project (`aokienji-ui-preview`) for the `ui-improvements` branch. It does not replace the production site. The deployment uses the Next.js framework preset, `DEMO_MODE=true`, `ALLOW_LIVE_ORDERS=false`, and a deployment-specific random `SESSION_SECRET`.

## Previous interview preview

Current preview URL: <https://aokienji-preview-fwe99n9dr-uta-s-daos-projects.vercel.app>

The Vercel team currently protects this deployment. Reviewers need access to the `uta-s-daos-projects` Vercel team; otherwise, add them to the team or change this project's Preview Deployment Protection in Vercel settings for the meeting.

The Vercel preview is for reviewing the public pages and the fictional demo catalog. It must not be presented as connected to Aoki Engineering's real inventory, suppliers, prices, or lead times.

- `.env.local`, `.data/aokienji.sqlite`, local admin credentials, and API keys are excluded from the deployment upload.
- The Vercel-only SQLite fallback uses `/tmp/aokienji-demo`. That storage is temporary and isolated to a running function instance. Data, sessions, and chat history can disappear after a cold start and are not shared reliably across instances.
- Demo mode stays enabled. Live supplier orders stay disabled.
- OpenAI, Jev/TypeSafe, and web-search keys are not configured in this preview. This avoids public use of billable APIs and avoids relying on the currently failing Jev credential.
- The chat uses the app's local rules in this preview; AI-generated answers are not enabled.
- The admin login is not initialized in this preview.
- This SQLite fallback is not a production database strategy.

The Preview environment already has a random `SESSION_SECRET` of at least 32 characters, `DEMO_MODE=true`, and `ALLOW_LIVE_ORDERS=false`. Do not copy the local `.env.local` file or database to Vercel.

## Before production use

1. Choose and provision a durable database. This app currently uses synchronous `better-sqlite3`; changing to a hosted database requires an application data-layer migration, schema migration, and updated code. Setting a Vercel environment variable alone will not migrate the database.
2. Review and explicitly approve the data to be made public. The current local database contains internal supplier knowledge and must not be uploaded as a project asset or seeded into the public demo.
3. Decide which AI, classification, and web-search providers to enable. Add only valid server-side credentials to the matching Vercel environment. The current Jev/TypeSafe key returned HTTP 401 in the latest connection test; replace it before selecting Jev. OpenAI is optional and incurs usage charges.
4. Set a unique `SESSION_SECRET` (at least 32 characters) and the final `APP_ORIGIN` in Preview/Production. Configure `ADMIN_PASSWORD_HASH` and initialize a production admin credential through a deployment-safe setup path before enabling `/admin`.
5. Keep `DEMO_MODE=true` and `ALLOW_LIVE_ORDERS` unset/false until company data, quote rules, and supplier order integrations are reviewed end to end.
6. Add object storage for uploaded source files if those imports need to survive deployments; database storage alone does not make transient function files durable.
7. Set up scheduled sync separately. Vercel deployment does not run `npm run sync` periodically by itself.

Environment variables are scoped to Preview or Production and take effect on a new deployment. Never commit secret values or copy `.env.local` into Vercel.
