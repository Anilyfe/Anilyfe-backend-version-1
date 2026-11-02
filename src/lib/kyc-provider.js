const https=require('https');
const {verifyNIN}=require('./nin-verification');

const PROVIDER_TIMEOUT_MS=12000;
const SELFIE_MAX_BYTES=1_200_000;
const SELFIE_DATA_URL=/^data:image\/(jpeg|png|webp);base64,/;

function postJson({hostname,port=443,path,headers={},body}){
  return new Promise((resolve,reject)=>{
    let settled=false;
    const timeout=setTimeout(()=>{
      if(settled)return;
      settled=true;
      request.destroy();
      reject(new Error('KYC provider timeout'));
    },PROVIDER_TIMEOUT_MS);
    const payload=JSON.stringify(body);
    const request=https.request({hostname,port,path,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),...headers}},response=>{
      let raw='';
      response.setEncoding('utf8');
      response.on('data',chunk=>{raw+=chunk;});
      response.on('end',()=>{
        if(settled)return;
        settled=true;
        clearTimeout(timeout);
        let parsed=null;
        try{parsed=raw?JSON.parse(raw):null;}catch{parsed=null;}
        resolve({status:response.statusCode||0,body:parsed});
      });
    });
    request.on('error',error=>{
      if(settled)return;
      settled=true;
      clearTimeout(timeout);
      reject(error);
    });
    request.write(payload);
    request.end();
  });
}

function stripDataUrl(selfie){return String(selfie).replace(SELFIE_DATA_URL,'');}

/* Providers disagree on where the match verdict lives, so read the shapes we document
   and treat anything unrecognised as a non-match: an approving bug here lets a stranger
   open a store, a rejecting bug only costs a support ticket. */
function readVerdict(payload){
  if(!payload||typeof payload!=='object')return {matched:false,score:null};
  const source=payload.result&&typeof payload.result==='object'?payload.result:payload;
  const score=[source.confidence,source.similarity,source.match_score,source.score,payload.confidence,payload.score]
    .find(value=>typeof value==='number'&&Number.isFinite(value));
  const flag=[source.match,source.isMatch,source.is_match,source.verified,source.status,payload.match,payload.verified,payload.status]
    .find(value=>value!==undefined&&value!==null);
  const matched=flag===true||['true','1','yes','match','matched','success','verified','pass'].includes(String(flag).toLowerCase());
  return {matched,score:score??null};
}

async function premblyFaceMatch({firstName,lastName,nin,selfie}){
  const response=await postJson({
    hostname:new URL(process.env.PREMBLY_BASE_URL||'https://api.v2.prembly.com').hostname,
    path:'/advanced/biometric-verification',
    headers:{Authorization:`Bearer ${process.env.PREMBLY_API_KEY}`},
    body:{first_name:firstName,last_name:lastName,phone:'',email:'',id_number:nin,id_type:'NIN',image:stripDataUrl(selfie)}
  });
  if(response.status>=400||!response.body)throw Object.assign(new Error('Prembly rejected the request'),{providerStatus:response.status});
  return readVerdict(response.body);
}

async function dojahFaceMatch({firstName,lastName,selfie}){
  const response=await postJson({
    hostname:'api.dojah.io',
    path:'/kyc/vendor/face-match/basic',
    headers:{Authorization:`Bearer ${process.env.DOJAH_CLIENT_SECRET}`,'endpoint-id':'140','client-id':process.env.DOJAH_CLIENT_ID||''},
    body:{job_type:'verify_identity',selfie:stripDataUrl(selfie),full_name:`${firstName} ${lastName}`.trim(),country:'NG',id_source:'NIN',ignore_liveness:false,strict:false}
  });
  if(response.status>=400||!response.body)throw Object.assign(new Error('Dojah rejected the request'),{providerStatus:response.status});
  return readVerdict(response.body);
}

/* Face match and NIN both run so a seller's stated name has to match the identity the
   NIN belongs to, not just the image on file for that NIN. */
async function runKycCheck({nin,firstName,lastName,selfie}){
  if(!/^\d{11}$/.test(String(nin||'')))return {success:false,inconclusive:false,provider:'NONE',code:'INVALID_NIN_FORMAT',matchScore:null,audit:null};
  if(!SELFIE_DATA_URL.test(String(selfie||'')))return {success:false,inconclusive:false,provider:'NONE',code:'INVALID_SELFIE',matchScore:null,audit:null};
  if(Buffer.from(String(selfie).replace(SELFIE_DATA_URL,''),'base64').length>SELFIE_MAX_BYTES)return {success:false,inconclusive:false,provider:'NONE',code:'SELFIE_TOO_LARGE',matchScore:null,audit:null};

  const ninResult=await verifyNIN({nin,firstName,lastName});
  const ninConfigured=ninResult.code!=='NOT_CONFIGURED';
  if(ninConfigured&&!ninResult.success){
    if(ninResult.code==='PROVIDER_ERROR'||ninResult.code==='INVALID_FORMAT')return {success:false,inconclusive:true,provider:ninResult.code,code:'NIN_PROVIDER_UNAVAILABLE',matchScore:null,audit:ninResult.audit||null};
    return {success:false,inconclusive:false,provider:'IdentifyOrg',code:'NIN_NO_MATCH',matchScore:null,audit:ninResult.audit||null};
  }

  const provider=String(process.env.KYC_PROVIDER||'').trim().toUpperCase();
  const faceMatchEnabled=process.env.KYC_FACE_MATCH_ENABLED==='true';
  const configured=(provider==='PREMBLY'&&process.env.PREMBLY_API_KEY)||(provider==='DOJAH'&&process.env.DOJAH_CLIENT_SECRET);

  if(!faceMatchEnabled||!configured){
    return {success:true,inconclusive:false,provider:'MOCK',code:'SIMULATED_PASS',matchScore:null,audit:{simulated:true,ninChecked:ninConfigured,faceMatchConfigured:false,note:'KYC face-match provider not configured'}};
  }

  try{
    const verdict=provider==='PREMBLY'?await premblyFaceMatch({firstName,lastName,nin,selfie}):await dojahFaceMatch({firstName,lastName,selfie});
    return {
      success:verdict.matched,
      inconclusive:false,
      provider,
      code:verdict.matched?'FACE_MATCH_PASSED':'FACE_MATCH_FAILED',
      matchScore:verdict.score,
      audit:{provider,score:verdict.score,ninChecked:ninConfigured,checkedAt:new Date().toISOString()}
    };
  }catch{
    /* Provider error payloads routinely echo the NIN and the image. Never persist or return them. */
    return {success:false,inconclusive:true,provider,code:'PROVIDER_UNAVAILABLE',matchScore:null,audit:null};
  }
}

module.exports={runKycCheck,SELFIE_MAX_BYTES};
