require('dotenv').config();
const fs = require('fs');
const path = require('path');

const API = 'http://localhost:4000';
const STAGE = 'C:/Users/Hp/Downloads/404.dev/Anii2/ANILyfe_V1_tailwind_anime/frontend/assets/images/staging-realistic';
const SELLER = { email: 'testseller@anilyfe.test', password: 'TestSeller123!' };
const ADMIN = { email: 'testadmin@anilyfe.test', password: 'TestAdmin123!' };

const BY_CATEGORY = {
  'Figures': 'prod-figures.png',
  'Collectibles': 'prod-collectibles.png',
  'Accessories': 'prod-accessories.png',
  'Manga & Books': 'prod-manga.png',
  'Art': 'prod-art.png',
  'Apparel': 'prod-apparel.png',
  'Gaming Products': 'prod-gaming.png',
};

async function login(body) {
  const res = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`login failed: ${JSON.stringify(json)}`);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

async function api(cookie, method, url, body) {
  const res = await fetch(`${API}${url}`, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(json)}`);
  return json.data;
}

async function uploadImage(cookie, filePath) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(filePath)], { type: 'image/png' }), path.basename(filePath));
  const res = await fetch(`${API}/api/uploads/image`, { method: 'POST', headers: { Cookie: cookie }, body: form });
  const json = await res.json();
  if (!res.ok) throw new Error(`upload -> ${res.status}: ${JSON.stringify(json)}`);
  return json.data.url;
}

(async () => {
  const sellerCookie = await login(SELLER);
  const adminCookie = await login(ADMIN);
  const products = await api(sellerCookie, 'GET', '/api/products?limit=100');

  for (const p of products.items) {
    const file = BY_CATEGORY[p.categoryName];
    if (!file) { console.log(`skip ${p.name} (no image mapped for ${p.categoryName})`); continue; }
    const url = await uploadImage(sellerCookie, path.join(STAGE, file));
    await api(sellerCookie, 'PATCH', `/api/products/${p.id}`, { images: [url] });
    await api(adminCookie, 'PATCH', `/api/admin/products/${p.id}/approval`, { status: 'APPROVED' });
    console.log(`OK  ${p.categoryName.padEnd(17)} ${p.name}`);
  }
  console.log('done');
})().catch(e => { console.error(e.message); process.exitCode = 1; });
