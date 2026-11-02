const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const VIBE = 'C:/Windows/system32/vibe_images';
const IMG = 'C:/Users/Hp/Downloads/404.dev/Anii2/ANILyfe_V1_tailwind_anime/frontend/assets/images';
const STAGE = path.join(IMG, 'staging-realistic');

fs.mkdirSync(STAGE, { recursive: true });

const JOBS = [
  // [source, outPath, width, height, format]
  ['manga-blue', `${IMG}/manga.png`, 900, 900, 'png'],
  ['auth-blue', `${IMG}/auth.png`, 1000, 1250, 'png'],
  ['empty-blue', `${IMG}/empty.png`, 800, 600, 'png'],
  ['manga-books-banner-blue', `${IMG}/web/manga-books.png`, 1440, 960, 'png'],
  ['figures-display-blue', `${IMG}/web/figures-display.jpg`, 1600, 914, 'jpg'],
  ['figures-cabinet-blue', `${IMG}/web/figures-cabinet.jpg`, 1080, 1620, 'jpg'],
  ['prod-mecha-figure', `${STAGE}/prod-figures.png`, 1024, 1024, 'png'],
  ['prod-enamel-pins', `${STAGE}/prod-collectibles.png`, 1024, 1024, 'png'],
  ['prod-keychains', `${STAGE}/prod-accessories.png`, 1024, 1024, 'png'],
  ['prod-manga-boxset', `${STAGE}/prod-manga.png`, 1024, 1024, 'png'],
  ['prod-art-print', `${STAGE}/prod-art.png`, 1024, 1024, 'png'],
  ['prod-hoodie', `${STAGE}/prod-apparel.png`, 1024, 1024, 'png'],
  ['prod-arcade-skin', `${STAGE}/prod-gaming.png`, 1024, 1024, 'png'],
];

function findSource(name) {
  const f = fs.readdirSync(VIBE).find(f => f.startsWith(name + '_'));
  if (!f) throw new Error(`source not found for ${name}`);
  return path.join(VIBE, f);
}

(async () => {
  for (const [name, out, w, h, fmt] of JOBS) {
    const src = findSource(name);
    let pipe = sharp(fs.readFileSync(src)).resize(w, h, { fit: 'cover' });
    let buf;
    if (fmt === 'jpg') {
      buf = await pipe.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
    } else {
      buf = await pipe.png({ palette: true, quality: 82, compressionLevel: 9 }).toBuffer();
    }
    const tmp = out + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, out);
    console.log(`${out}  ${(buf.length / 1024).toFixed(0)} KB`);
  }
  console.log('done');
})().catch(e => { console.error(e); process.exitCode = 1; });
