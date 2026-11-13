import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {privateAcl,ensurePrivateDir,assertPrivate,writePrivate} from '../private-files.mjs';
test('Windows ACL 判定不把 Unix mode 当作权限，排除其他用户访问',()=>{
 const base={sid:'S-1-5-21-FIXTURE',owner:'S-1-5-21-FIXTURE',rules:[{identity:'S-1-5-21-FIXTURE',allow:true},{identity:'S-1-5-18',allow:true}]};
 assert(privateAcl(base));assert(!privateAcl({...base,rules:[...base.rules,{identity:'S-1-1-0',allow:true}]}));assert(!privateAcl({...base,owner:'S-1-1-0'}));
});
test('本机私有目录和文件可创建、验证，重复写入不覆盖',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dw-private-'));try{await ensurePrivateDir(root);await assertPrivate(root,{directory:true});const p=join(root,'fixture.key');await writePrivate(p,'FIXTURE_ONLY');await assertPrivate(p);await assert.rejects(writePrivate(p,'overwrite'),e=>e.code==='EEXIST');}finally{await rm(root,{recursive:true,force:true});}
});
