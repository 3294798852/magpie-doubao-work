import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSession,withDeviceContext,backupRows} from '../native/session.mjs';

test('设备上下文随账号保存，迁入空白主机时保留源设备信息',async()=>{
  for (const device of ['account-one-device','account-two-device']) {
    const source = await withDeviceContext(normalizeSession({cookieHeader:'sessionid=fixture',userAgent:'fixture-agent'}),async()=>device);
    assert.equal(source.deviceId,device);
    assert.equal(source.fingerprint,'verify_'+device);
    const destination = await withDeviceContext(JSON.parse(JSON.stringify(source)),async()=>{
      assert.fail('A portable account must not read destination device files.');
    });
    assert.deepEqual(destination,source);
    assert.equal(destination.userAgent,'fixture-agent');
  }
});

test('Cookie 设备号和显式账号设备号优先于目标主机设备',async()=>{
  const local = async()=>assert.fail('Account context must take precedence.');
  const cookie = await withDeviceContext(normalizeSession({cookieHeader:'sessionid=fixture;device_id=cookie-device'}),local);
  assert.equal(cookie.deviceId,'cookie-device');
  assert.equal(cookie.fingerprint,'verify_cookie-device');
  const explicit = await withDeviceContext({...cookie,deviceId:'account-device'},local);
  assert.equal(explicit.deviceId,'account-device');
  assert.equal(explicit.fingerprint,'verify_account-device');
  assert.equal(await withDeviceContext(explicit,local),explicit);
});

test('v2/v3 备份完整保留设备上下文和客户端元数据',()=>{
  const session={cookieHeader:'sessionid=fixture',deviceId:'portable-device',fingerprint:'verify_portable-device',
    webId:'fixture-web',clientVersion:'2.33.5',userAgent:'fixture-agent',channel:'fixture',chromiumVersion:'147'};
  for (const version of [2,3]) {
    const account={id:'fixture',provider:'doubaowork',name:'Fixture',desktop:false,
      pluginIdentity:'fixture:0',pluginSecret:session,session};
    assert.deepEqual(backupRows({schema:'doubao-work-accounts/v1',version,accounts:[account]})[0].session,session);
  }
});
