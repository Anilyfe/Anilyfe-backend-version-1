const {IdentifyOrgClient}=require('@identifyorg/node-sdk');

async function verifyNIN({nin,firstName,lastName}){
  if(!/^\d{11}$/.test(String(nin||'')))return {success:false,code:'INVALID_FORMAT'};
  if(process.env.NIN_VERIFICATION_ENABLED!=='true'||!process.env.IDENTIFYORG_API_KEY)return {success:false,code:'NOT_CONFIGURED'};
  let timeoutId;
  try{
    const client=new IdentifyOrgClient({apiKey:process.env.IDENTIFYORG_API_KEY});
    const result=await Promise.race([client.verify.nin({nin,first_name:firstName,last_name:lastName}),new Promise((_,reject)=>{timeoutId=setTimeout(()=>reject(new Error('Provider timeout')),8000);})]);
    return {success:result?.status==='success'&&result?.match===true,code:result?.status==='success'?'NO_MATCH':'PROVIDER_ERROR',audit:{providerStatus:typeof result?.status==='string'?result.status:null,match:result?.match===true}};
  }catch{
    // Provider error objects can contain personal data. Deliberately discard them.
    return {success:false,code:'PROVIDER_ERROR'};
  }finally{clearTimeout(timeoutId);}
}

module.exports={verifyNIN};
