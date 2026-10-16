# Cloudflare R2 product image setup

1. Create a private R2 bucket for marketplace uploads.
2. Create an R2 API token with object read/write permission limited to that bucket.
3. Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and `R2_PUBLIC_URL` on the backend. Keep the secret key backend-only.
4. Configure a public custom domain for reads, or another controlled public read path, and set its base URL in `R2_PUBLIC_URL`.
5. Set bucket CORS to allow `PUT` from the production frontend origin and required local development origin, with `Content-Type` request header. Do not use wildcard origins for production.
6. Test an approved seller's image upload and verify the resulting object can be read through the public URL before enabling this for customers.

The backend issues five-minute, content-type and declared-size-bound presigned PUT URLs for JPEG, PNG, and WebP images up to 8 MB. The seller browser uploads directly to R2; ANILyfe stores the returned public URL with the product. When R2 is not configured, the existing authenticated backend upload path is used as a temporary fallback. Do not commit R2 credentials.
