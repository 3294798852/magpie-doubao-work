// Provider failures become bounded, credential-free domain errors.
export function normalizeProviderError(raw={}, {httpStatus=502}={}){
 const value=upstreamCode(raw);
 const code=typeof value==='number'?value:/^\d{1,12}$/.test(String(value))?Number(value):undefined;
 let type='upstream_error',state='',status=502,message='豆包上游请求未完成，请查看账号状态后再操作。';
 if(code===710022004){type='account_verification_required';state='needs_verification';status=429;message='豆包上游要求人工验证（710022004）。请使用同一账号在豆包官网或客户端完成验证后重试；重新登录可更新账号会话。';}
 else if(httpStatus===401){type='account_login_required';state='needs_login';status=401;message='豆包登录会话已失效，请重新登录此账号。';}
 else if(httpStatus===429){type='upstream_rate_limited';state='rate_limited';status=429;message='豆包上游暂时限流，请稍后再发起新请求。';}
 const error=new Error(message);return Object.assign(error,{status,type,state,retryable:false,...(code!==undefined?{upstream_code:code}:{})});
}
export function upstreamCode(value){
 const codes=[value?.upstream_code,value?.error_code,value?.error?.upstream_code,value?.error?.code,value?.data?.error_code,value?.code,value?.status_code];
 return codes.find(c=>String(c)==='710022004')??codes.find(c=>/^\d{1,12}$/.test(String(c))&&Number(c)!==0);
}
