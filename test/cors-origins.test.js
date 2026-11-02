const test=require('node:test');
const assert=require('node:assert/strict');
const {createCorsOptions,normalizeOrigin,compile,DEFAULT_ORIGINS}=require('../src/lib/cors');

/* The matcher hands (origin, cb) to the cors package, so the tests drive that signature directly. */
function decide(env,origin){
  const handler=createCorsOptions(env).origin;
  let error=null,allowed=false;
  handler(origin,(err,result)=>{error=err;allowed=result===true;});
  return {error,errorResult:error&&error.message,allowed};
}

test('a missing FRONTEND_ORIGIN falls back to the defaults for the environment without throwing',()=>{
  for(const env of [{},{NODE_ENV:'production'},{NODE_ENV:'development'},{NODE_ENV:'production',FRONTEND_ORIGIN:''},{FRONTEND_ORIGIN:'   '},{FRONTEND_ORIGIN:undefined}]){
    const {list}=compile(env.FRONTEND_ORIGIN,env.NODE_ENV);
    const expected=String(env.NODE_ENV||'').toLowerCase()==='production'?DEFAULT_ORIGINS.production:DEFAULT_ORIGINS.development;
    assert.deepEqual(list,expected,JSON.stringify(env));
  }
});

test('an empty, quoted or whitespace-only allow list never leaves the app with no origins at all',()=>{
  assert.deepEqual(compile(',, ,',  'production').list,DEFAULT_ORIGINS.production);
  assert.deepEqual(compile('["https://shop.example.com"]','production').list,['https://shop.example.com']);
});

test('a trailing slash, quotes, spacing or a bare host still allow the real frontend origin',()=>{
  const real='https://myanilyfe.vercel.app';
  for(const configured of [
    `${real}/`,
    `${real}/`,
    `"${real}"`,
    `"${real}"`,
    `"${real}", "https://other.example.com"`,
    real,
    'myanilyfe.vercel.app',
    'MYAnilyfe.Vercel.App/'
  ]){
    assert.equal(decide({NODE_ENV:'production',FRONTEND_ORIGIN:configured},real).allowed,true,`configured as ${configured}`);
  }
});

test('an origin that is not listed is refused with no CORS header, which is the browser error the frontend saw',()=>{
  const result=decide({NODE_ENV:'production',FRONTEND_ORIGIN:'https://myanilyfe.vercel.app'},'https://evil.example.com');
  assert.equal(result.allowed,false);
  assert.equal(result.errorResult,'CORS origin not allowed');
});

test('subdomain lookalikes are not matched by an exact entry',()=>{
  const env={NODE_ENV:'production',FRONTEND_ORIGIN:'https://myanilyfe.vercel.app'};
  for(const lookalike of [
    'https://myanilyfe.vercel.app.evil.com',
    'https://evil-myanilyfe.vercel.app',
    'https://myanilyfe.vercel',
    'http://myanilyfe.vercel.app'
  ]){
    assert.equal(decide(env,lookalike).allowed,false,lookalike);
  }
});

test('a wildcard entry covers Vercel preview deployments and echoes the requesting origin',()=>{
  const env={NODE_ENV:'production',FRONTEND_ORIGIN:'https://*.vercel.app'};
  for(const preview of ['https://anilyfe-git-main-cdiv.vercel.app','https://myanilyfe-frontend.vercel.app']){
    assert.equal(decide(env,preview).allowed,true,preview);
  }
  assert.equal(decide(env,'https://vercel.app').allowed,false,'the bare domain is not a subdomain');
  assert.equal(decide(env,'https://a.b.vercel.app').allowed,false,'only one label is matched');
  assert.equal(decide(env,'https://anilyfe.vercel.app.evil.com').allowed,false,'nothing after the matched suffix');
});

test('requests without an Origin header are allowed: curl, health checks and webhooks are not browser reads',()=>{
  assert.equal(decide({NODE_ENV:'production'},undefined).allowed,true);
  assert.equal(decide({NODE_ENV:'production'},'').allowed,true);
});

test('the allow list never answers with a wildcard origin because sessions ride on cookies',()=>{
  const options=createCorsOptions({NODE_ENV:'production',FRONTEND_ORIGIN:'*'});
  assert.equal(options.credentials,true);
  assert.equal(decide({NODE_ENV:'production',FRONTEND_ORIGIN:'*'},'https://anywhere.example.com').allowed,false);
});

test('only a leftmost-label wildcard is honoured; a bare or mid-host wildcard is refused outright',()=>{
  assert.equal(decide({NODE_ENV:'production',FRONTEND_ORIGIN:'https://*'},'https://anywhere.example.com').allowed,false);
  assert.equal(decide({NODE_ENV:'production',FRONTEND_ORIGIN:'https://anilyfe-*.vercel.app'},'https://anilyfe-preview.vercel.app').allowed,false);
});

test('normalizeOrigin only ever returns scheme+host, or nothing',()=>{
  assert.equal(normalizeOrigin('https://Shop.Example.com/'),  'https://shop.example.com');
  assert.equal(normalizeOrigin('  http://localhost:5500/  '), 'http://localhost:5500');
  assert.equal(normalizeOrigin('shop.example.com'),           'https://shop.example.com');
  assert.equal(normalizeOrigin('localhost:5500'),             'http://localhost:5500');
  assert.equal(normalizeOrigin('http://[::1]:5500'),          'http://[::1]:5500');
  assert.equal(normalizeOrigin(''),                            '');
  assert.equal(normalizeOrigin(null),                          '');
  assert.equal(normalizeOrigin(undefined),                     '');
});
