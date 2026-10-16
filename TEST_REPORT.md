# ANILyfe integration test report

Run date: 2026-10-16

## Automated checks completed

- `npm test`: **7 passed, 0 failed** (existing Paystack-mode tests plus shipping/NIN format unit tests).
- JavaScript syntax checks: backend and frontend sources checked with `node --check`.
- `prisma validate`: **passed** using schema validation only; no database was contacted.
- `prisma generate`: **passed**; generated the client from the updated schema. No migration was applied.
- Browser layout/responsive checks at 360, 768, and 1280 px: **not run**; the local browser smoke check used its normal viewport only.
- Local browser smoke check: homepage, buyer login/recovery/reset screens, seller login redirect, and admin login screen opened. Buyer and admin password visibility toggles were verified after fixing a modal event-handling issue. The marketplace showed **Marketplace unavailable** because the configured backend API requests failed with `Failed to fetch`.

## 20-step acceptance flow

These flows require a dedicated test database, a sandbox email sender, IdentityOrg test key, R2 test bucket, or Paystack test configuration. They were not run against live services or production data.

| # | Flow | Result |
|---:|---|---|
| 1 | Admin login persists across refresh | Not run: needs safe test database/admin account. Session JWT and cookie lifetimes are role-specific in code. |
| 2 | Admin announcement appears on homepage | Not run: writes database data. |
| 3 | Buyer signup creates user and cart | Not run: writes database data. |
| 4 | Buyer login and password visibility toggle | Login UI and toggle checked in browser; backend login not run because API is unreachable. |
| 5 | Forgot password email and reset | Recovery/reset screens checked in browser; email/reset API not run: needs test account and configured Resend sender/API key. |
| 6 | Seller signup creates pending application | Not run: writes database data. |
| 7 | Valid NIN verification | Not run: IdentifyOrg test key and safe test data required. Backend-only flow and redacted storage implemented. |
| 8 | Invalid 10-digit NIN rejection | Format validation implemented; API-level request not run without test database. |
| 9 | Unreachable NIN provider allows manual review | Offline format logic tested; API fallback code implemented, integration flow not run. |
| 10 | Admin approval and founding seller number | Not run: writes database data. Transactional assignment implemented. |
| 11 | Seller product creation | Not run: writes database data. |
| 12 | Product image upload to R2 | Not run: requires a test bucket and CORS configuration. Presigned upload route implemented; local upload fallback retained. |
| 13 | Product approval/public listing | Not run: writes database data. |
| 14 | Buyer catalog displays products/images | Attempted in browser; marketplace unavailable because API fetch failed. |
| 15 | Buyer cart | Not run: writes database data. |
| 16 | Checkout shipping/order | Pure shipping cases tested; database checkout not run. |
| 17 | Paystack test transaction | Not run: no checkout/payment was initiated. |
| 18 | Seller sees order | Not run: depends on checkout database state. |
| 19 | Admin marks order shipped | Not run: writes database data. |
| 20 | Buyer sees shipped status | Not run: depends on steps 16–19. |

## Remaining activation work

Set the backend environment variables described in `SETUP_NIN.md` and `SETUP_R2.md`, add a verified Resend sender, review/apply the Prisma migration in a controlled environment, then run the end-to-end flow against dedicated test data. Configure the production callback and allowed origins before deployment. No Git push or deployment was performed.

## Live-style browser and backend smoke pass (2026-10-16)

- Frontend opened through the local browser at `http://127.0.0.1:8765/` (this is not the public deployment).
- Homepage, shipping, payment-security, returns, FAQ, and 404 routes rendered. Buyer cart/checkout/orders and seller center redirected unauthenticated users to the sign-in page; the admin dashboard redirected to admin login. No test credentials were entered.
- No broken `<img>` elements were found on the checked routes. The visible Marketplace error is caused by its data request failing, not by a missing local image file; no static product images were substituted for seller listings.
- Local backend `/api/health` returned HTTP 200. Read-only `/api/products?limit=3`, `/api/settings`, and `/api/announcements` each returned HTTP 500 because Prisma could not connect to the configured Neon database host. The test-mode Paystack setup was not used to initialize a transaction.
- The configured public Render API health endpoint could not be reached from this environment (connection closed during TLS/HTTP receive).
- No signup, login, order, admin mutation, migration, upload, or payment was performed. Consequently protected buyer, seller, and admin data flows remain unverified until the database and public API are reachable.
