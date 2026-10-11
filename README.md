# ANILyfe Backend V1

This backend is designed around the existing ANILyfe HTML/CSS/JavaScript frontend. It replaces marketplace localStorage/mock persistence with a Node.js + Express API and PostgreSQL source of truth.

## Requirements
- Node.js 20+ recommended
- Docker Desktop (recommended for local PostgreSQL) OR PostgreSQL 16+
- npm

## 1. Start PostgreSQL
From this folder:
```bash
docker compose up -d postgres
```
If you already have PostgreSQL installed, create a database named `anilyfe` and adjust `DATABASE_URL` in `.env`.
For deployments, set `DATABASE_URL` to the Supabase transaction-pooler URL for the running application, and `DIRECT_URL` to the Supabase direct connection (or session-pooler URL) for Prisma migrations. Keep both connection strings private.

## 2. Install dependencies
```bash
npm install
```

## 3. Create environment file
Windows:
```powershell
copy .env.example .env
```
macOS/Linux:
```bash
cp .env.example .env
```
Then edit `.env` and replace `JWT_SECRET` with a long random value.

For Paystack, add:
```text
PAYSTACK_MODE=test
PAYSTACK_SECRET_KEY=sk_test_...
PAYSTACK_PUBLIC_KEY=pk_test_...
```
Local and staging payments require a matching test-mode secret key. Live keys are rejected outside production, and production requires `PAYSTACK_MODE=live` with a live-prefixed secret. Never commit real keys; the committed example intentionally contains no credentials.

## 4. Generate Prisma client and create database tables
```bash
npx prisma generate
npx prisma migrate deploy
npx prisma db seed
```
The seed only creates safe marketplace settings. It does NOT create fake users, sellers, products, orders, payments or an admin.

## 5. Create or promote the first super administrator
For an empty database, create an administrator and elevate it with the explicitly authorized CLI commands:
```bash
npm run admin:create -- --email=admin@example.com --password="<strong-unique-password>"
npm run admin:super-promote -- admin@example.com
```
For an existing database, promote a trusted active administrator with `npm run admin:super-promote -- admin@example.com`. Verify the target account and back up the database first. This script does not run automatically.

## 6. Admin applications
The private, unlisted signup route is `/#/admin-signup`. Applications cannot sign in or access admin APIs while pending. Only a super administrator can approve or reject them; approval requires assigning `ADMIN` or `SUPER_ADMIN`. The route is intentionally absent from marketplace navigation, but its URL is not a security control.

## 7. Start the API
Development:
```bash
npm run dev
```
Production-style local start:
```bash
npm start
```
Expected API:
```text
http://localhost:4000
```
Health check:
```text
http://localhost:4000/health
```

## 8. Frontend integration
The bundle now includes `js/api-integration.js`, loaded after the existing frontend scripts. It keeps the current UI/routes and routes core marketplace operations through the backend. Set the `<meta name="anilyfe-api">` value in `index.html` to your deployed API URL for production.

Authentication uses an HttpOnly session cookie; marketplace records are not persisted to browser localStorage by the API integration layer.

## 9. Production checklist
- Back up PostgreSQL before applying migrations; run `npx prisma migrate deploy` only after the history and schema checks below pass.
- For a pre-existing database, inspect both its schema and `_prisma_migrations` history before deploying. If the database records an applied migration missing from the local `migrations/` directory, restore the exact migration directory and SQL from version control or a deployment backup first. Do not deploy a new baseline over existing tables, mark a differently named baseline as applied, or alter migration history to silence a status mismatch.
- Only when a database genuinely has no migration history, compare its schema to the checked-in baseline. After a verified backup and an exact match, mark that baseline as applied with `npx prisma migrate resolve --applied <baseline-migration-id>`, then deploy later migrations. Never mark a baseline applied on an empty or unverified database.
- Set a strong `JWT_SECRET`.
- Set `DATABASE_URL` to the Supabase transaction-pooler connection string and `DIRECT_URL` to the direct/session-pooler connection string in the deployment environment.
- Set `FRONTEND_ORIGIN` to the exact production frontend origin(s).
- Configure `PAYSTACK_MODE=live`, the matching live `PAYSTACK_SECRET_KEY`, and webhook `/api/payments/webhook`. Use test-mode keys for non-production environments.
- Replace local `uploads/` with object storage.
- Configure transactional email for support/notifications.
- Use HTTPS in production.

## Testing
Syntax validation can be run without PostgreSQL:
```bash
find src scripts -name "*.js" -print0 | xargs -0 -n1 node --check
```
Full integration tests require `npm install`, a running PostgreSQL database, migrations and test configuration.

## Production notes
- Replace local `uploads/` with S3-compatible object storage.
- Use HTTPS.
- Use a strong `JWT_SECRET` and secure deployment secrets.
- Restrict CORS to the deployed ANILyfe frontend origin.
- Configure Paystack webhook URL to `/api/payments/webhook`.
- Add transactional email provider before enabling automatic email notifications.
- Back up PostgreSQL.


## V1 integration pass
- Frontend server-owned marketplace reads now resolve through the API integration state.
- Cart, orders, authentication, seller/product moderation, admin settings, notifications, analytics, payouts and checkout use backend endpoints where implemented.
- Administrator applications are accepted only through the private unlisted signup route and remain pending until super-admin approval and role assignment.
- `/api/health` is the canonical health endpoint.
- Production sessions use `SameSite=None; Secure`; local development uses `SameSite=Lax`.
- Browser automation was not used as a completion criterion; run the provided tests against a real PostgreSQL database before production.
"# Anilyfe-backend-version-1" 
