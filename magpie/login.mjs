import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {BrowserLogin} from '../browser-login.mjs';
import {securePrivate} from '../private-files.mjs';

// Magpie invokes the automatic callback immediately and supplies cancellation.
export async function browserSignIn(signIn, {signal, browserOptions = {}} = {}) {
  const root = await mkdtemp(join(tmpdir(),'magpie-doubaowork-'));
  let login, result;
  try {
    await securePrivate(root,{directory:true});
    login = new BrowserLogin({...browserOptions, tmpRoot:root,
      async importAccount(cookies) {
        result = await signIn({cookies},{signal});
        return {name:result.name,updated:false};
      },
    });
    signal?.throwIfAborted();
    await login.start();
    while (login.status().active) await delay(100,undefined,{signal});
    const status = login.status();
    if (status.state !== 'success' || !result)
      return {type:'failed',error:status.message};
    return result;
  } finally {
    await login?.dispose();
    if (!login?.status().cleanupPending) await rm(root,{recursive:true,force:true});
  }
}
