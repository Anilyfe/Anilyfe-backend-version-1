const {fail}=require('../lib/http');
function notFound(req,res){fail(res,404,'NOT_FOUND','API route not found.')}
function errorHandler(err,req,res,next){
  console.error(err);
  if(err.code==='P2002') return fail(res,409,'DUPLICATE','A record with the same unique value already exists.');
  if(err.code==='P2025') return fail(res,404,'NOT_FOUND','Requested record was not found.');
  if(err.code==='P2003') return fail(res,409,'REFERENCE_CONFLICT','This record cannot be changed because it is still in use.');
  if(err.code==='APPLICATION_ALREADY_REVIEWED') return fail(res,409,err.code,err.message);
  if(err.code==='PAYMENT_NOT_PENDING'||err.code==='ORDER_PAYMENT_STATE_CONFLICT') return fail(res,409,err.code,err.message);
  if(err.code==='SELLER_PII_KEY_MISSING') return fail(res,503,'SELLER_APPLICATION_STORAGE_UNAVAILABLE','Seller application storage is not configured. Contact marketplace support.');
  if(err.code==='SELLER_APPLICATION_INCOMPLETE'||err.code==='FOUNDING_SELLER_LIMIT_REACHED') return fail(res,409,err.code,err.message);
  if(err.code==='AMOUNT_MISMATCH') return fail(res,400,'AMOUNT_MISMATCH','Payment amount could not be verified.');
  if(err.code==='SHIPPING_UNAVAILABLE') return fail(res,400,'SHIPPING_UNAVAILABLE',err.message);
  if(err.name==='ZodError') return fail(res,400,'VALIDATION_ERROR','Request validation failed.',err.issues);
  if(err.name==='MulterError') return fail(res,400,'UPLOAD_ERROR',err.code==='LIMIT_FILE_SIZE'?'The uploaded file is too large.':'The uploaded file could not be processed.');
  if(err.message==='CORS origin not allowed') return fail(res,403,'CORS_BLOCKED','This origin is not allowed to access the API.');
  if(err instanceof SyntaxError && 'body' in err) return fail(res,400,'INVALID_JSON','Request body must contain valid JSON.');
  return fail(res,500,'SERVER_ERROR',process.env.NODE_ENV==='production'?'An internal server error occurred.':err.message);
}
module.exports={notFound,errorHandler}
