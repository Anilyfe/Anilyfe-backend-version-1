function minimumPrice(productType){
  return productType==='DIGITAL'?1000:2000;
}

function validatePrice(productType,price,discount=0,variants=[]){
  if(!['PHYSICAL','DIGITAL'].includes(productType))return false;
  const minimum=minimumPrice(productType);
  if(!Number.isFinite(Number(price))||Number(price)*(1-Number(discount||0)/100)<minimum)return false;
  return variants.every(variant=>Number(variant.price??price)*(1-Number(discount||0)/100)>=minimum);
}

module.exports={minimumPrice,validatePrice};
