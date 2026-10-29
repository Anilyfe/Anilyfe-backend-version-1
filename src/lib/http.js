function asyncHandler(fn){return (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next)}
function ok(res,data,status=200){return res.status(status).json({success:true,data})}
function fail(res,status,code,message,details){return res.status(status).json({success:false,error:{code,message,details:details||undefined}})}
function decimal(n){return Number(n||0)}
module.exports={asyncHandler,ok,fail,decimal}
