# IdentifyOrg NIN verification setup

ANILyfe verifies NIN values only through the backend. Never place the IdentifyOrg secret in frontend configuration.

1. Create an IdentifyOrg account and obtain a test API key from the provider dashboard.
2. Set `IDENTIFYORG_API_KEY` on the backend. Keep `NIN_VERIFICATION_ENABLED=false` until a test key and the correct legal/privacy notices are ready.
3. Set `NIN_VERIFICATION_ENABLED=true` to enable `POST /api/sellers/me/verification/nin`.
4. Test with the provider's documented sandbox data only. Do not send real identity numbers while testing.
5. Set the live key only after compliance review, privacy notice/consent review, and production access approval.

The endpoint validates an 11-digit number, sends it to IdentifyOrg from the server, and returns only a verification status. ANILyfe stores the masked last four digits, provider name, status, and verification time. The audit JSON contains only a whitelisted provider status and boolean match value; provider PII and the submitted NIN are discarded and never logged. Disabled or unreachable verification is recorded as `PENDING` so the seller application can still be reviewed manually.

Use `NIN_VERIFICATION_ENABLED=false` for ordinary development. Required backend variables are listed in `.env.example`.
