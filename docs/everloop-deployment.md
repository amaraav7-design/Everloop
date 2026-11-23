# Everloop repository and deployment preparation

The destination for this installation is
[amaraav7-design/Everloop](https://github.com/amaraav7-design/Everloop).
The application is derived from [ArnasDon/wacrm](https://github.com/ArnasDon/wacrm).
The original README, developer documentation, MIT copyright and license, and
third-party notices are retained. The repository name does not change the
application's branding or upstream attribution.

## Configuration stays outside Git

Keep actual environment files, Supabase credentials, Meta secrets, API keys,
passwords, local MCP client configuration and browser sessions outside Git.
The root ignore rules also apply to the optional `mcp-server/` directory.
The upstream environment examples are templates only; never put real values in
an example file. Ignore rules do not remove previously tracked files or history,
so inspect both staged content and the history before publishing changes.

Supply installation values through local ignored environment files or the
hosting provider's environment settings. Server credentials, including the
Supabase service-role key, Meta app secret and encryption key, must not use a
`NEXT_PUBLIC_` variable name. Do not include local exports, logs, benchmarks,
customer records or database backups in the repository.

For configuration and operational details, retain and use the original
[README](../README.md), [auth email and redirect guide](auth-emails.md),
[WhatsApp troubleshooting](whatsapp-connection-troubleshooting.md),
[multiple-WABA guide](multi-waba.md), [Docker guide](docker.md) and
[MCP guide](mcp.md).

## Verified local baseline

The preparation on 2026-10-23 used Next.js and matching ESLint configuration
16.4.2, with compatible lockfile patches for `ip-address`, `hono` and
`@hono/node-server`. Lint completed with zero errors and warnings; type checking,
1,509 tests and a production build passed. The build used temporary Node.js
22.23.4 without changing the system Node installation.

Signed-in local checks against the configured Supabase loaded dashboard,
contacts, inbox and profile settings. Contacts and inbox were empty; WhatsApp
was disconnected. One dashboard request failed temporarily and recovered on the
normal refresh; a subsequent full reload passed. A background presence request
also reported a fetch failure. The dashboard error's cause was not established.
Pipelines was not opened because an empty-board visit can create default records.
No customer-record edits, sending or WhatsApp connection were tested.

At the security review, the remaining `braces@3.0.3` tooling issue accounted for
nine full-audit entries, seven under production-only auditing. Retaining the
current tooling with this known limitation was an explicit decision. The local
investigation found no CRM request path or deployed runtime dependency using the
affected tooling; this is not a claim that all vulnerabilities are resolved.

## Next deployment step

After repository access and the push are confirmed, review a Vercel import of
the repository root containing `package.json`. Confirm the runtime, build and
environment configuration before deployment. Keep preview and production
configuration deliberate, review auth redirect URLs for the chosen domain, and
verify the database schema before enabling cron jobs or the WhatsApp webhook.
This preparation does not deploy Vercel, run migrations, change Supabase settings,
or connect WhatsApp.

## Rollout and pilot

### Local verification

Use `npm run dev` with a disposable test database or fixture service for interactive checks. Run `npm run build` and `npm run start` with the same test settings to check the compiled release. The local worktree’s environment file points at production, so supply isolated settings when starting a verification server.

The signed-in browser check used synthetic data at a 390 px viewport. Sign-in, inbox navigation, the contact sheet, the expired reply window, the campaign opt-out preview, scheduling confirmation, and the offline screen passed. All 62 migrations and schema assertions passed on fresh and populated local PostgreSQL fixtures. The populated run also checked the owner, admin, agent, and viewer roles and access from a separate account.

### Apply and verify

1. In an isolated local or hosted Supabase environment, apply migrations through 067. Run the schema checks in `supabase/ci/verify-schema.sql` after both a fresh setup and an upgrade from sanitized representative data.
2. Configure an HTTPS `NEXT_PUBLIC_SITE_URL` for invitations and add the exact login and reset callback to Supabase Auth. Confirm owner, admin, agent and viewer access in two separate test workspaces.
3. Schedule both worker endpoints every minute. Keep the worker secret in the host’s secret storage and send it as `x-cron-secret` or an `Authorization: Bearer` header. If Vercel Cron runs these endpoints, put the same worker secret in `WHATSAPP_WORKER_CRON_SECRET` and `CRON_SECRET` and confirm that the project plan supports minute schedules. Alert on repeated HTTP 503 responses or sustained queue growth.
   - `GET /api/whatsapp/webhook/drain` recovers accepted webhook payloads.
   - `GET /api/whatsapp/campaigns/drain` claims scheduled campaign work.
   - Webhook receipt deletion defaults to off. Enable `WHATSAPP_PRUNE_WEBHOOK_RECEIPTS=true` only after approving the 14-day retention cleanup for completed and failed receipts.
4. Set `WHATSAPP_CAMPAIGN_ACCOUNTS` to the comma-separated staging workspace IDs to enable launches and claims there. Use `*` only after the rollout is verified. Clearing the allowlist stops new dashboard launches and worker claims. Already-dispatched sends may still complete and reconcile.
5. Leave `EVERLOOP_AI_AUTO_REPLY_ACCOUNTS` unset for the initial draft pilot. Configure test keys in Settings → AI Agents. Test OpenRouter’s free-only switching and quota handling, and use a synthetic sample for Google AI Studio. Confirm the Google project’s billing tier in Google AI Studio. Google bills by the project’s settings.
6. For opt-in device notifications, generate a VAPID key pair and configure `EVERLOOP_VAPID_PUBLIC_KEY`, `EVERLOOP_VAPID_PRIVATE_KEY`, and `EVERLOOP_VAPID_SUBJECT` (a contact email prefixed with `mailto:`, or an HTTPS URL). Use separate VAPID credentials in staging and production.

### Exercise the workflow

- Use designated, consented test contacts. Verify the Meta connection and the exact approved template language. Preview and test-send a template with personalization before running a small scheduled campaign. Close the browser and verify the scheduler continues processing it. Check pause, cancel, resume, duplicate launch, rate-limit recovery and signed callbacks for accepted, delivered, read and failed messages. Confirm that an opted-out contact stays suppressed and an ambiguous job does not resend.
- Have a test contact start a conversation and verify the in-window free-form reply. Finish with a confirmed reply to the original campaign message and a separate read receipt. Run the inbox on an iPhone and Android in both browser and installed modes. Check keyboard, attachment, voice note, offline/reconnect, and device-alert behavior. Confirm that another account cannot open the notification’s conversation.
- Start with one inbound journey in the existing workflow builder. Route a customer-initiated conversation to a teammate and apply a tag only when the qualification criteria are met. Run it on the designated test workspace first. Allow further marketing only through eligible template sends and check end-of-journey and opt-out behavior with test contacts.

### Measure the pilot

| Measure | Calculation |
| --- | --- |
| Eligible audience | Unique, valid recipients who pass template and consent checks at preflight |
| Acceptance rate | Meta-accepted recipients divided by recipients attempted |
| Delivery rate | Recipients with delivery evidence divided by Meta-accepted recipients |
| Read rate | Recipients with explicit read receipts divided by delivered recipients |
| Direct reply rate | Recipients replying to the campaign message divided by delivered recipients |
| Inferred replies | Replies linked to the latest eligible send within seven days, reported separately |
| Opt-outs | Distinct recipients who opted out during the measured period |
| First response time | Time from inbound to the first human response, with median and 95th percentile |
| Qualified leads | Contacts meeting the team’s qualification rule, reported using the pilot tag |

Record webhook lag and queued, uncertain and failed recipient counts before widening the rollout. Measure inbox open time under the same device and network conditions before and after the change. Compare lead and conversion outcomes after a reliable booking or deal event is available. Keep estimated cost separate from provider-reported spend. A local build and database fixture run establish functional behavior. Production throughput and marketing results require the live pilot.

### Recover a rollout

Pause affected campaigns first. Clear the campaign account allowlist to stop new worker claims and disable managed auto-replies for the workspace. Leave receipt processing enabled so in-flight status callbacks can still reconcile. Review uncertain legacy and worker-based sends before retrying a recipient. Keep the new schema in place during an app rollback until pending jobs have been reconciled.
