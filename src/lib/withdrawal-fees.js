const DEFAULT_WITHDRAWAL_FEES=Object.freeze({
  BUYER:Object.freeze([
    {upTo:10000,fee:100},
    {upTo:30000,fee:200},
    {upTo:50000,fee:300},
    {upTo:100000,fee:500},
    {upTo:null,fee:1000}
  ]),
  SELLER:Object.freeze([
    {upTo:10000,fee:50},
    {upTo:30000,fee:100},
    {upTo:50000,fee:200},
    {upTo:100000,fee:300},
    {upTo:null,fee:500}
  ])
});

function calculateWithdrawalFee(accountType,amount,schedule=DEFAULT_WITHDRAWAL_FEES){
  if(!['BUYER','SELLER'].includes(accountType))throw new TypeError('Withdrawal account type must be BUYER or SELLER.');
  const requested=Number(amount);
  if(!Number.isFinite(requested)||requested<=0||Math.round(requested*100)!==requested*100)throw new RangeError('Withdrawal amount must be positive and have at most two decimal places.');
  const tiers=schedule?.[accountType];
  if(!Array.isArray(tiers)||tiers.length===0)throw new TypeError(`Withdrawal fee schedule is missing for ${accountType}.`);
  const tier=tiers.find(item=>item.upTo===null||requested<=Number(item.upTo));
  if(!tier||!Number.isFinite(Number(tier.fee))||Number(tier.fee)<0)throw new TypeError(`Withdrawal fee schedule is invalid for ${accountType}.`);
  const fee=Math.round(Number(tier.fee)*100)/100;
  return {accountType,requestedAmount:requested,feeAmount:fee,netAmount:Math.max(0,requested-fee)};
}

function validateWithdrawalFeeSchedule(schedule){
  if(!schedule||typeof schedule!=='object')return false;
  for(const accountType of ['BUYER','SELLER']){
    const tiers=schedule[accountType];
    if(!Array.isArray(tiers)||tiers.length!==5)return false;
    let previous=0;
    for(let index=0;index<tiers.length;index++){
      const tier=tiers[index];
      if(!tier||!Number.isFinite(Number(tier.fee))||Number(tier.fee)<0)return false;
      if(index===tiers.length-1){if(tier.upTo!==null)return false;continue;}
      const ceiling=Number(tier.upTo);
      if(!Number.isFinite(ceiling)||ceiling<=previous)return false;
      previous=ceiling;
    }
  }
  return true;
}

module.exports={DEFAULT_WITHDRAWAL_FEES,calculateWithdrawalFee,validateWithdrawalFeeSchedule};
