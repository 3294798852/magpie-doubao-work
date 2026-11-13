import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,lstat,chmod,open,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const run=promisify(execFile),cache=new Map();
const ps=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
// Use Windows PowerShell 5's .NET ACL API, not modules inherited from a pwsh 7 parent.
const aclPrelude=`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
$p = $env:DW_PRIVATE_PATH
$directory = $env:DW_PRIVATE_KIND -eq 'directory'
$sidType = [System.Security.Principal.SecurityIdentifier]
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($directory) { $acl = [System.IO.Directory]::GetAccessControl($p) }
else { $acl = [System.IO.File]::GetAccessControl($p) }
`;
const inspectScript=aclPrelude+`
[Console]::WriteLine($me.Value)
[Console]::WriteLine($acl.GetOwner($sidType).Value)
foreach ($entry in $acl.GetAccessRules($true,$true,$sidType)) {
 $allow = if ($entry.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) { '1' } else { '0' }
 [Console]::WriteLine($entry.IdentityReference.Value + ':' + $allow)
}
`;
const secureScript=aclPrelude+`
$inheritance = if ($directory) { 'OICI' } else { '' }
# Replace inherited and explicit grants with one protected DACL.
$sddl = 'D:P(A;' + $inheritance + ';FA;;;' + $me.Value + ')(A;' + $inheritance + ';FA;;;SY)'
$acl.SetSecurityDescriptorSddlForm($sddl,[System.Security.AccessControl.AccessControlSections]::Access)
if ($directory) { [System.IO.Directory]::SetAccessControl($p,$acl) }
else { [System.IO.File]::SetAccessControl($p,$acl) }
[Console]::WriteLine('PRIVATE_OK')
`;
function parseAcl(raw){
 const [sid,owner,...entries]=raw.split(/\r?\n/),id=/^S-\d+(?:-\d+)+$/;
 if(!id.test(sid)||!id.test(owner))return null;
 const rules=[];
 for(const entry of entries){
  const [identity,mode,...tail]=entry.split(':');
  if(tail.length||!id.test(identity)||!['0','1'].includes(mode))return null;
  rules.push({identity,allow:mode==='1'});
 }
 return {sid,owner,rules};
}
export function privateAcl(data){
 if(!data||typeof data.sid!=='string'||!Array.isArray(data.rules))return false;
 const allowed=new Set([data.sid,'S-1-5-18','S-1-5-32-544']);
 return allowed.has(data.owner)&&data.rules.some(r=>r.allow&&r.identity===data.sid)&&data.rules.every(r=>r.allow===false||r.allow===true&&allowed.has(r.identity));
}
async function powershell(script,path,directory=false){
 const encoded=Buffer.from(script,'utf16le').toString('base64');
 try{return (await run(ps,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{
  env:{...process.env,DW_PRIVATE_PATH:resolve(path),DW_PRIVATE_KIND:directory?'directory':'file'},
  windowsHide:true,timeout:20000,maxBuffer:128*1024,
 })).stdout.trim();}
 catch(e){
  const category=String(e.stderr||'').replace(/_x000D_|_x000A_/g,' ').match(/FullyQualifiedErrorId\s*:\s*([A-Za-z0-9_.]+(?:,[A-Za-z0-9_.]+)?)/)?.[1]||e.code;
  const hint=typeof category==='string'&&/^[A-Za-z0-9_.,-]{1,100}$/.test(category)?'（'+category+'）':'';
  throw Error('Windows 私有文件权限检查未完成'+hint+'，请检查当前用户对运行目录的控制权限。');
 }
}
export async function assertPrivate(path,{directory=false}={}){
 const info=await lstat(path);if(info.isSymbolicLink()||!(directory?info.isDirectory():info.isFile()))throw Error('私有路径类型异常。');
 if(process.platform!=='win32'){if(info.mode&0o077)throw Error('私有文件或目录权限过宽。');return;}
 const key=resolve(path),sig=[info.ino,info.mtimeMs,info.ctimeMs,info.size].join(':'),old=cache.get(key);
 if(old?.sig===sig&&old.until>Date.now())return;
 const data=parseAcl(await powershell(inspectScript,path,directory));if(!privateAcl(data))throw Error('Windows 私有文件存在其他用户的访问权限，请使用 secure-cloud 或收紧目录 ACL。');
 cache.set(key,{sig,until:Date.now()+10000});if(cache.size>256)cache.delete(cache.keys().next().value);
}
export async function securePrivate(path,{directory=false}={}){
 if(process.platform==='win32'){
  const info=await lstat(path);
  if(info.isSymbolicLink()||!(directory?info.isDirectory():info.isFile()))throw Error('私有路径类型异常。');
  if(await powershell(secureScript,path,directory)!=='PRIVATE_OK')throw Error('私有文件权限设置未完成。');
  cache.delete(resolve(path));
 }
 else await chmod(path,directory?0o700:0o600);
}
export async function ensurePrivateDir(path){await mkdir(path,{recursive:true,mode:0o700});await securePrivate(path,{directory:true});}
export async function writePrivate(path,value,{flag='wx'}={}){
 const file=await open(path,flag,0o600);try{await securePrivate(path);await file.writeFile(value);await file.sync();}catch(error){await file.close();if(flag==='wx')await unlink(path).catch(()=>{});throw error;}await file.close();
}
