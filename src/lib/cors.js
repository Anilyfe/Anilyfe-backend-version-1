/* ANILyfe — CORS origin allow-list.
 * The browser symptom of a bad allow-list is "No 'Access-Control-Allow-Origin' header is present",
 * because a rejected origin is answered with 403 and deliberately no CORS header. That makes an
 * allow-list typo (trailing slash, quotes, a space after the comma) indistinguishable from an attack,
 * so entries are normalised here and every rejection is logged with the origin that caused it.
 */
const DEFAULT_ORIGINS={
  production:['https://myanilyfe.vercel.app','https://anilyfe-frontend.vercel.app'],
  development:['http://localhost:5500','http://127.0.0.1:5500','http://localhost:4000']
};
const LOCAL_HOSTS=['localhost','127.0.0.1','::1'];

function normalizeOrigin(value){
  /* Quotes and brackets are env-file and JSON-array residue, never part of an origin. IPv6 hosts like
     http://[::1]:5500 keep their brackets because they sit inside the value, not at either end. */
  const text=String(value===undefined||value===null?'':value).replace(/^[\s"'[\]]+|[\s"'[\]]+$/g,'');
  if(!text)return '';
  const stripped=text.replace(/\/+$/,'');       // https://x/ and https://x are the same origin
  if(/^[a-z][a-z0-9+.-]*:\/\//i.test(stripped))return stripped.toLowerCase();
  const host=stripped.replace(/^\/+/,'').toLowerCase();
  /* A host without a scheme is a paste slip, not an origin: resolve it to the only two things it can be. */
  return `${LOCAL_HOSTS.some(name=>host===name||host.startsWith(`${name}:`))?'http':'https'}://${host}`;
}

/* Deliberately narrow: `*` is only honoured as the leftmost host label, so https://*.vercel.app means
   "any single subdomain of vercel.app". A bare `*`, a mid-host wildcard or a wildcarded path would turn
   a cookie-carrying allow list into "any site on the internet", so those entries are dropped instead. */
const SAFE_WILDCARD=/^https?:\/\/\*(?:\.[a-z0-9-]+)+$/;

function toRegExp(pattern){
  const escaped=pattern.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[a-z0-9](?:[a-z0-9-]*[a-z0-9])?');
  return new RegExp(`^${escaped}$`);
}

function compile(configured,nodeEnv){
  const configuredList=String(configured===undefined||configured===null?'':configured)
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);
  const isProduction=String(nodeEnv||'').toLowerCase()==='production';
  const list=configuredList.length?configuredList:DEFAULT_ORIGINS[isProduction?'production':'development'];
  const exact=list.filter(entry=>!entry.includes('*'));
  const wildcardPatterns=list.filter(entry=>entry.includes('*'));
  const unsafe=wildcardPatterns.filter(entry=>!SAFE_WILDCARD.test(entry));
  if(unsafe.length)console.warn(`CORS: ignoring wildcard entries that are too broad to honour safely: ${unsafe.join(', ')}`);
  const wildcards=wildcardPatterns.filter(entry=>SAFE_WILDCARD.test(entry)).map(toRegExp);
  return {list,allows:origin=>exact.includes(origin)||wildcards.some(test=>test.test(origin))};
}

function createCorsOptions(env){
  const {list,allows}=compile(env&&env.FRONTEND_ORIGIN,env&&env.NODE_ENV);
  const warned=new Set();
  return {
    credentials:true,
    origin(origin,cb){
      /* Requests with no Origin header (curl, health checks, same-origin, webhooks) are not browser
         cross-origin reads, so they are never the thing this list is guarding against. */
      if(!origin)return cb(null,true);
      if(allows(origin))return cb(null,true);
      if(!warned.has(origin)){
        warned.add(origin);
        console.warn(`CORS: blocked origin "${origin}". Add it to FRONTEND_ORIGIN if it is trusted. Current allow list: ${list.join(', ')}`);
      }
      cb(new Error('CORS origin not allowed'));
    }
  };
}

module.exports={createCorsOptions,normalizeOrigin,compile,DEFAULT_ORIGINS};
