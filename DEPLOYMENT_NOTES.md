# Deployment configuration notes

Deploy the backend and frontend only after applying `prisma/migrations/20261016090000_security_nin` to the intended database through the normal migration approval process.

Backend environment variables added/used by this work:

- `RESEND_API_KEY`, `EMAIL_FROM`: password reset emails. Verify the sender domain with Resend first.
- `IDENTIFYORG_API_KEY`, `NIN_VERIFICATION_ENABLED`: keep disabled until provider sandbox testing and privacy/compliance review are complete.
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL`: Cloudflare R2 product image uploads.
- `FOUNDING_SELLER_LIMIT`: maximum numbered founding sellers (default 50).
- `FRONTEND_ORIGIN`: comma-separated exact frontend origins. Production defaults allow the known Vercel hosts if this variable is empty.
- `PAYSTACK_MODE=test` and matching test keys for a test environment only. Never put test credentials in a production deployment.

Set the frontend API metadata URL to the intended backend origin and configure the Paystack callback URL to the deployed hash-route callback before deployment. Validate login, reset email, NIN sandbox, R2 CORS, and Paystack in a separate test environment first. No deployment or migration was performed by this change.
