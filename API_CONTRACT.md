# ANILyfe Frontend ↔ Backend API Contract — V1

## Contract principle
The existing HTML/CSS/JS frontend remains the UI. Its marketplace services become API clients. PostgreSQL is the source of truth. LocalStorage must not be used for marketplace records, money, authentication, inventory, orders, reviews, seller verification, payouts, notifications or admin authorization.

### Standard response envelope
Success:
```json
{"success":true,"data":{}}
```
Error:
```json
{"success":false,"error":{"code":"ERROR_CODE","message":"Human-readable message","details":[]}}
```

Common errors: `AUTH_REQUIRED` 401, `AUTH_INVALID` 401, `FORBIDDEN` 403, `VALIDATION_ERROR` 400, `NOT_FOUND` 404, `DUPLICATE` 409, `SERVER_ERROR` 500.

## Roles
- `BUYER`: buyer account and personal marketplace activity.
- `SELLER`: approved seller operations for that seller only.
- `ADMIN`: explicitly assigned server-side role. Frontend route access never grants admin privileges.
- Developer/technical access is not an Anilyfe Admin role.

## Service mapping
| Existing frontend service | Primary backend API |
|---|---|
| authService | `/api/auth` |
| productService | `/api/products` |
| sellerService | `/api/sellers` |
| storeService | `/api/sellers/:idOrSlug` |
| inventoryService | `/api/inventory` |
| cartService / cart UI | `/api/cart` |
| orderService | `/api/orders` |
| deliveryService | `/api/sellers/me/settings` + `/api/orders` |
| paymentService | `/api/payments` |
| reviewService | `/api/reviews` |
| payoutService | `/api/payouts` |
| notificationService | `/api/notifications` |
| analyticsService | `/api/analytics` |
| verificationService | `/api/sellers/me/verification` |
| settingsService | `/api/sellers/me/settings`, `/api/auth` |
| auditService | backend-only `/api/admin/audit-logs` |
| adminNotificationService | `/api/notifications` + backend-created admin notifications |
| support UI | `/api/support` |
| admin UI | `/api/admin/*` |

## Auth endpoints
### POST `/api/auth/register`
Auth: public. Creates BUYER only.
Request:
```json
{"email":"buyer@example.com","password":"minimum-8-chars","firstName":"John","lastName":"Doe","phone":"08000000000","country":"Nigeria","state":"Rivers","city":"Port Harcourt","lga":"Obio-Akpor"}
```
Response data: `{user:{id,email,firstName,lastName,role:"BUYER"}}`. Authentication is established with an HttpOnly `anilyfe_access` cookie; the token is not returned to browser JavaScript.
Errors: `EMAIL_EXISTS`, `VALIDATION_ERROR`.

### POST `/api/auth/login`
Auth: public.
Request: `{"email":"buyer@example.com","password":"..."}`
Response: user. Authentication is established with an HttpOnly `anilyfe_access` cookie.
Errors: `INVALID_CREDENTIALS`, `ACCOUNT_INACTIVE`.

### GET `/api/auth/me`
Auth: any authenticated role.
Response: current user plus seller profile if present.

### POST `/api/auth/change-password`
Auth: any authenticated role.
Request: `{"currentPassword":"...","newPassword":"..."}`.

## Seller endpoints
### POST `/api/sellers/apply`
Auth: BUYER (authenticated). Creates seller application; account role becomes SELLER.
Request:
```json
{"businessName":"Example Store","slug":"example-store","bio":"Anime products","category":"Figures","state":"Rivers","city":"Port Harcourt","lga":"Obio-Akpor","phone":"08000000000","businessEmail":"store@example.com"}
```
Status values: `PENDING`, `APPROVED`, `REJECTED`, `SUSPENDED`.
Errors: `SELLER_EXISTS`.

### GET `/api/sellers/me/profile`
Auth: SELLER.
Returns seller profile and verification.

### PATCH `/api/sellers/me/profile`
Auth: SELLER; seller-owned fields only. Cannot set admin role, approval, commission or financial values.

### GET/PATCH `/api/sellers/me/settings`
Auth: SELLER. Stores delivery rules, dispatch state/location, notification preferences and payout-account information.

### GET `/api/sellers/me/verification`
Auth: SELLER.
Verification statuses: `NOT_STARTED`, `UNDER_REVIEW`, `APPROVED`, `REJECTED`.

### POST `/api/sellers/me/verification`
Auth: SELLER. Submits/resubmits verification. Server moves status to `UNDER_REVIEW`.

### GET `/api/sellers/:idOrSlug`
Auth: public. Only approved sellers are public. Returns approved/published seller products.

## Product endpoints
### GET `/api/products`
Auth: public for marketplace catalog; SELLER receives own seller products; ADMIN can use admin endpoint for moderation.
Query: `search`, `category`, `sellerId`, `status`, `page`, `limit`.
Public status values: `APPROVED`, `PUBLISHED`, `OUT_OF_STOCK`.

### POST `/api/auth/logout`
Auth: authenticated. Clears the HttpOnly session cookie.

### GET `/api/products/:idOrSlug`
Auth: public for published/approved products; owner/admin may access non-public records.

### POST `/api/products`
Auth: approved SELLER only.
Request shape:
```json
{"name":"Product name","category":"Figures & Collectibles","price":25000,"discount":10,"description":"...","images":["https://.../image.jpg"],"colors":["Black"],"sizes":["A3"],"sku":"SKU-001","variants":[{"sku":"SKU-001-BLK-A3","color":"Black","size":"A3","price":25000,"stock":5}],"dimensions":{"width":"12","height":"18","depth":"2","unit":"in"},"shipping":{"weightKg":1,"freeShippingInState":false},"submitForApproval":true}
```
Server derives sale price and aggregate stock. Seller cannot set Approved/Published directly.
Status lifecycle: `DRAFT` → `PENDING_APPROVAL` → `APPROVED`/`PUBLISHED`; `REJECTED` → resubmit → `PENDING_APPROVAL`; `ARCHIVED`; `OUT_OF_STOCK`.

### PATCH `/api/products/:id`
Auth: owning SELLER. Important published changes force `PENDING_APPROVAL`.

### POST `/api/products/:id/restore`
Auth: owning SELLER. Restores an archived product to `PENDING_APPROVAL` when it has stock, otherwise `DRAFT`.

### POST `/api/products/:id/submit`
Auth: owning SELLER. Requires at least one image; moves Draft/Rejected to Pending Approval.

### POST `/api/products/:id/archive` / DELETE `/api/products/:id`
Auth: owning SELLER.

## Admin moderation endpoints
### GET `/api/admin/sellers`
Auth: ADMIN.
### PATCH `/api/admin/sellers/:id/approval`
Auth: ADMIN.
Request: `{"status":"APPROVED"}` or `{"status":"REJECTED","rejectionReason":"Reason"}`.
### GET `/api/admin/products`
Auth: ADMIN.
### PATCH `/api/admin/products/:id/approval`
Auth: ADMIN.
Request: `{"status":"APPROVED"}` or `{"status":"REJECTED","rejectionReason":"Reason"}`.
The server checks that the seller is approved. Rejection reason is mandatory for `REJECTED`.
### GET `/api/admin/orders`
Auth: ADMIN. Read-only order view for fulfillment status.
### GET `/api/admin/users`
Auth: ADMIN.
### GET `/api/admin/dashboard`
Auth: ADMIN. Metrics are database-derived.
### GET/PATCH `/api/admin/settings`
Auth: ADMIN. Includes commission, maintenance mode, seller registration and review settings.
### GET `/api/admin/audit-logs`
Auth: ADMIN.
### POST `/api/admin/promote-admin`
Auth: ADMIN only. Explicitly assigns ADMIN role to a chosen user. No public admin registration route exists.

## Cart endpoints
### GET `/api/cart`
Auth: authenticated buyer/seller-as-buyer.
### POST `/api/cart/items`
Auth: authenticated.
Request: `{"productId":"...","variantId":"...","quantity":2}`.
Server validates availability and stock.
### PATCH `/api/cart/items/:id`
Auth: owner.
### DELETE `/api/cart/items/:id` and `DELETE /api/cart`
Auth: owner.

## Order endpoints
### POST `/api/orders`
Auth: authenticated buyer.
Request contains delivery details only; server reads authoritative cart/product prices and calculates subtotal, shipping, buyer fees, commission and seller earnings.
Example request:
```json
{"country":"Nigeria","state":"Rivers","city":"Port Harcourt","lga":"Obio-Akpor","addressLine":"Example address","recipientName":"John Doe","recipientPhone":"08000000000"}
```
Server response includes `orderNumber`, items, subtotal, shipping, commissionRate, commissionAmount, sellerEarnings, total, paymentStatus and orderStatus.
Order statuses: `PENDING_PAYMENT`, `CONFIRMED`, `PROCESSING`, `READY_TO_SHIP`, `SHIPPED`, `DELIVERED`, `CANCELLED`, `REFUND_PENDING`, `REFUNDED`, `RETURN_REQUESTED`, `RETURNED`.
Payment statuses: `PENDING`, `AUTHORIZED`, `PAID`, `FAILED`, `REFUNDED`.

### GET `/api/orders`
Auth: BUYER gets own orders; SELLER gets own seller orders; ADMIN can use this or `/api/admin/orders`.
### GET `/api/orders/:id`
Auth: order owner, owning seller or ADMIN.
### PATCH `/api/orders/:id/status`
Auth: owning SELLER. Allowed fulfillment transitions are server-controlled. Payment must be `PAID` before fulfillment.

## Payments
### POST `/api/payments/initialize`
Auth: order-owning BUYER.
Request: `{"orderId":"..."}`.
Server reads the order total. Frontend cannot supply its own payable amount.
Response includes Paystack reference and checkout URL.
### POST `/api/payments/webhook`
Auth: Paystack signature, not user JWT. Server validates `x-paystack-signature` and marks an order paid only after verified gateway success.
### GET `/api/payments/:reference`
Auth: payment owner or ADMIN.

## Reviews and questions
### GET `/api/reviews/product/:productId`
Auth: public.
### POST `/api/reviews`
Auth: authenticated buyer; requires a delivered order containing the product.
Request: `{"productId":"...","orderId":"...","rating":5,"title":"Great","body":"..."}`.
### POST `/api/reviews/:id/reply`
Auth: owning SELLER.
### GET `/api/reviews/questions/:productId`
Public.
### POST `/api/reviews/questions`
Authenticated buyer.
### POST `/api/reviews/questions/:id/answer`
Owning SELLER.

## Inventory
### GET `/api/inventory`
Auth: SELLER/ADMIN.
### PATCH `/api/inventory/variants/:id`
Auth: owning SELLER. Server validates stock and records inventory movement.
### GET `/api/inventory/history`
Auth: SELLER/ADMIN.

## Payouts
### GET `/api/payouts`
Auth: SELLER. Returns database-derived balance and payout history.
### POST `/api/payouts/request`
Auth: SELLER. Requires payout account and sufficient server-derived available balance.
### GET `/api/payouts/admin`
Auth: ADMIN.
### PATCH `/api/payouts/admin/:id`
Auth: ADMIN.

## Notifications
### GET `/api/notifications`
Auth: authenticated. Returns user-specific plus role notifications.
### PATCH `/api/notifications/:id/read`
Auth: notification owner or matching role.
### POST `/api/notifications/read-all`
Auth: authenticated.

## Support
### POST `/api/support`
Auth: public or authenticated.
Request: `{"email":"customer@example.com","subject":"Help","message":"..."}`.
### GET `/api/support`
Auth: customer gets own tickets; ADMIN gets all.
### PATCH `/api/support/:id`
Auth: ADMIN.

## Analytics
### GET `/api/analytics/overview`
Auth: SELLER/ADMIN. Metrics are calculated from PostgreSQL records.

## Uploads
### POST `/api/uploads/image`
Auth: authenticated. Multipart field: `file`. V1 stores locally for development. Production should replace the storage adapter with S3-compatible/object storage.

## Public
### GET `/api/announcements`
Public active announcements.
### GET `/api/settings`
Public marketplace settings that are safe to expose.

## Financial invariants
1. Client-submitted commission is ignored.
2. Client-submitted seller earnings are ignored.
3. Client-submitted payment success is ignored.
4. Product/cart prices are re-read from the database.
5. Shipping is recalculated server-side.
6. Commission defaults to 15% and is snapshotted on each order.
7. Seller balances are derived from paid marketplace orders and payout records.
8. Paystack webhook verification is required before payment is authoritative.

## Future extension points
The schema intentionally keeps separate settings, product variants, payment provider enum, currency field, seller badges/founding seller fields, announcement/media structures and delivery-rule JSON. This allows future ads, promoted products, affiliates, AI moderation, advanced badges/reduced commissions, additional countries/currencies and delivery engines without redesigning core order/product/user relationships.
