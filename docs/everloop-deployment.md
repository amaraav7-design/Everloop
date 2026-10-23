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
