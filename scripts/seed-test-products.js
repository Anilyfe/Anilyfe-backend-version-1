require('dotenv').config();
const fs = require('fs');
const path = require('path');

const API = 'http://localhost:4000';
const IMG_DIR = path.join(__dirname, '../../../frontend/assets/images');
const SELLER = { email: process.env.QA_SELLER_EMAIL, password: process.env.QA_SELLER_PASSWORD };
const ADMIN = { email: process.env.QA_ADMIN_EMAIL, password: process.env.QA_ADMIN_PASSWORD };
if (!SELLER.email || !SELLER.password || !ADMIN.email || !ADMIN.password) {
  throw new Error('Set QA_SELLER_EMAIL, QA_SELLER_PASSWORD, QA_ADMIN_EMAIL, and QA_ADMIN_PASSWORD before running this local QA seeder.');
}

const PRODUCTS = [
  { name: 'Nakamura Mecha Figure - Limited Edition', category: 'Figures', file: 'figures.png', brand: 'AniCraft Studio', price: 45000, sku: 'FIG-NAK-001', shortDescription: 'Hand-painted 24cm mecha statue with LED base, limited to 500 units worldwide.' },
  { name: 'Sakura Emblem Enamel Pin Set', category: 'Collectibles', file: 'collectibles.png', brand: 'AniCraft Studio', price: 8500, sku: 'COL-SAK-001', shortDescription: 'Set of 5 hard-enamel collector pins with butterfly clasps and display card.' },
  { name: 'Retro Cat Keychain & Charm Set', category: 'Accessories', file: 'accessories.png', brand: 'Lagos Anime Co.', price: 4200, sku: 'ACC-CAT-001', shortDescription: 'Acrylic keychain trio with kawaii cat mascots in chibi style.' },
  { name: 'Blade of the Dawn Manga Box Set Vol. 1-3', category: 'Manga & Books', file: 'manga.png', brand: 'InkDawn Press', price: 12000, sku: 'MNG-DAWN-001', shortDescription: 'First three volumes of the hit samurai fantasy manga, English edition.' },
  { name: 'Neon Ronin Framed Art Print A3', category: 'Art', file: 'art.png', brand: 'Studio Violet', price: 15500, sku: 'ART-RON-001', shortDescription: 'Museum-grade giclee print, neon-lit ronin illustration, matte black frame.' },
  { name: 'Academy Hero Oversized Hoodie', category: 'Apparel', file: 'apparel.png', brand: 'Lagos Anime Co.', price: 28000, sku: 'APP-ACA-001', shortDescription: 'Heavyweight 400gsm fleece hoodie with embroidered academy crest.' },
  { name: 'Pixel Fighter Arcade Stick Skin', category: 'Gaming Products', file: 'gaming.png', brand: 'PixelForge', price: 9800, sku: 'GAM-PXF-001', shortDescription: 'Vinyl skin set for fight sticks and controllers, retro pixel-art finish.' },
];

async function login(body) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`login failed: ${JSON.stringify(json)}`);
  const raw = res.headers.get('set-cookie') || '';
  const cookie = raw.split(';')[0];
  if (!cookie) throw new Error('no session cookie returned');
  return cookie;
}

async function api(cookie, method, url, body, headers = {}) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(json)}`);
  return json.data;
}

async function uploadImage(cookie, filePath) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'image/png' }), path.basename(filePath));
  const res = await fetch(`${API}/api/uploads/image`, { method: 'POST', headers: { Cookie: cookie }, body: form });
  const json = await res.json();
  if (!res.ok) throw new Error(`upload ${filePath} -> ${res.status}: ${JSON.stringify(json)}`);
  return json.data.url;
}

(async () => {
  const sellerCookie = await login(SELLER);
  const adminCookie = await login(ADMIN);
  const created = [];

  for (const p of PRODUCTS) {
    const url = await uploadImage(sellerCookie, path.join(IMG_DIR, p.file));
    const product = await api(sellerCookie, 'POST', '/api/products', {
      name: p.name,
      brand: p.brand,
      category: p.category,
      price: p.price,
      sku: p.sku,
      shortDescription: p.shortDescription,
      description: `${p.shortDescription} Ships anywhere in Nigeria from Lagos. Part of the ANILyfe test catalogue.`,
      images: [url],
      variants: [{ sku: p.sku, price: p.price, stock: 10, color: 'Standard', size: 'Standard' }],
      submitForApproval: true
    });
    const approved = await api(adminCookie, 'PATCH', `/api/admin/products/${product.id}/approval`, { status: 'APPROVED' });
    created.push({ name: p.name, category: p.category, status: approved.status, price: p.price, id: product.id });
    console.log(`OK  ${p.category.padEnd(17)} ${p.name}  [${approved.status}]`);
  }

  console.log(`\nCreated and approved ${created.length} products.`);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
