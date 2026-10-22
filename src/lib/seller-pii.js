const crypto=require('crypto');

const PREFIX='enc:v1:';

function encryptionKey(){
  const configured=process.env.SELLER_PII_ENCRYPTION_KEY;
  if(!configured)throw Object.assign(new Error('Seller application storage is not configured.'),{code:'SELLER_PII_KEY_MISSING'});
  return crypto.createHash('sha256').update(configured).digest();
}

function encryptSellerPii(value){
  if(!value)return value;
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey(),iv);
  const encrypted=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
  return `${PREFIX}${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}

function decryptSellerPii(value){
  if(typeof value!=='string'||!value.startsWith(PREFIX))return value;
  const [iv,tag,ciphertext]=value.slice(PREFIX.length).split(':');
  const decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(iv,'base64url'));
  decipher.setAuthTag(Buffer.from(tag,'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext,'base64url')),decipher.final()]).toString('utf8');
}

function maskSellerPii(value){
  if(!value)return value;
  const raw=decryptSellerPii(value);
  return `•••••••${raw.slice(-4)}`;
}

module.exports={encryptSellerPii,decryptSellerPii,maskSellerPii};
