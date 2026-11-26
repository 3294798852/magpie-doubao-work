import {mkdtemp} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {BrowserLogin,removeLoginDirectory} from '../browser-login.mjs';
import {securePrivate} from '../private-files.mjs';

// Magpie invokes the automatic callback immediately and supplies cancellation.
export async function browserSignIn(signIn, {signal, browserOptions = {}} = {}) {
  const root = await mkdtemp(join(tmpdir(),'magpie-doubaowork-'));
  let login, result;
  try {
    await securePrivate(root,{directory:true});
    login = new BrowserLogin({diagnosticFile:join(homedir(),'.cache','doubao-work','magpie-browser-startup.json'),
      ...browserOptions, tmpRoot:root,
      async importAccount(cookies,_context,metadata) {
        result = await signIn({cookies,...metadata,clientProfile:'web'},{signal});
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
    if(login?.status().cleanupPending)
      console.error('[doubaowork.browser] '+JSON.stringify(login.status().diagnostic||{code:'DW_BROWSER_CLEANUP_PENDING'}));
    if (!login?.status().cleanupPending) await removeLoginDirectory(root);
  }
}
