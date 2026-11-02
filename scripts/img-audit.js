const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const DIR = process.argv[2] || 'C:/Users/Hp/Downloads/404.dev/Anii2/ANILyfe_V1_tailwind_anime/frontend/assets/images';
const files = fs.readdirSync(DIR).filter(f => /\.(png|jpg|jpeg)$/i.test(f));

(async () => {
  for (const f of files) {
    try {
      const { data, info } = await sharp(path.join(DIR, f)).resize(64, 64, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
      let r = 0, g = 0, b = 0, n = info.width * info.height;
      for (let i = 0; i < data.length; i += info.channels) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
      r /= n; g /= n; b /= n;
      const warm = r - b;
      console.log(`${f.padEnd(28)} avg RGB (${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)})  ${warm > 12 ? '<< WARM' : warm > 0 ? '~neutral' : 'blue'}`);
    } catch (e) { console.log(`${f}: ERROR ${e.message.split('\n')[0]}`); }
  }
})();
