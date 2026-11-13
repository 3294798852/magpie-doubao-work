import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {desktopStatePaths,createDesktopDeviceReader} from '../native/desktop-device.mjs';

test('豆包客户端设备文件使用 Windows、Linux 与 macOS 的应用数据路径',()=>{
  assert.deepEqual(desktopStatePaths('win32','home',{LOCALAPPDATA:'local'}),[
    join('local','Doubao','User Data','Local State'),
    join('local','DoubaoWork','User Data','Local State'),
  ]);
  assert.equal(desktopStatePaths('linux','home',{XDG_CONFIG_HOME:'config'})[0],join('config','Doubao','Local State'));
  assert.equal(desktopStatePaths('linux','home',{})[1],join('home','.config','DoubaoWork','Local State'));
  assert.equal(desktopStatePaths('darwin','home',{})[0],join('home','Library','Application Support','Doubao','Local State'));
});

test('设备读取只接受有效客户端字段，兼容两个产品目录',async()=>{
  for (const value of ['device-123',123,'',{},9007199254740992,'invalid device']) {
    let reads = 0;
    const reader = createDesktopDeviceReader({platform:'linux',home:'home',env:{},
      async read(file) {
        reads++;
        if (file.includes('DoubaoWork')) return JSON.stringify({aha:{device:{device_id:value}}});
        throw Object.assign(Error('not installed'),{code:'ENOENT'});
      }});
    const expected = ['device-123',123].includes(value) ? String(value) : undefined;
    assert.equal(await reader(),expected);
    assert.equal(reads,2);
  }
});

test('并发与缺失设备查询共用缓存，60 秒后重新读取',async()=>{
  let at = 0, reads = 0;
  const reader = createDesktopDeviceReader({platform:'linux',home:'home',env:{},now:()=>at,
    async read() {
      reads++;
      return at === 0 ? '{updating' : JSON.stringify({aha:{device:{device_id:'new-device'}}});
    }});
  assert.deepEqual(await Promise.all([reader(),reader(),reader()]),[undefined,undefined,undefined]);
  assert.equal(reads,2);
  at = 59999;
  assert.equal(await reader(),undefined);
  assert.equal(reads,2);
  at = 60000;
  assert.equal(await reader(),'new-device');
  assert.equal(reads,3);
  assert.equal(await reader(),'new-device');
  assert.equal(reads,3);
});
