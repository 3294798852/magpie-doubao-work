import {randomUUID} from 'node:crypto';
import {completionChunks,completionError} from '../native/completion.mjs';

export function errorResponse(error, requestId) {
  const result = completionError(error, requestId);
  const headers = {'Cache-Control':'no-store', 'X-Request-Id':requestId};
  if (error?.state === 'needs_login') headers['X-Magpie-Sign-In'] = 'expired';
  if (error?.upstream_code === 710022004) headers['X-Should-Retry'] = 'false';
  if (error?.retryAt) headers['Retry-After'] = String(Math.max(1,Math.ceil((error.retryAt-Date.now())/1000)));
  return Response.json(result.body, {status:result.status, headers});
}

export async function chatResponse(body, chat, {signal, now = Date.now} = {}) {
  const requestId = 'dw-' + randomUUID();
  const abort = new AbortController();
  const combined = signal ? AbortSignal.any([signal,abort.signal]) : abort.signal;
  const chunks = completionChunks(chat(body,{signal:combined,requestId}), body, {signal:combined,requestId,now});
  let first;
  try {
    first = await chunks.next();
  } catch (error) {
    combined.throwIfAborted();
    return errorResponse(error, requestId);
  }
  const headers = {'Cache-Control':'no-store', 'X-Request-Id':requestId};
  if (!body.stream) {
    await chunks.return();
    return Response.json(first.value, {headers});
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(first.value)); },
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        if (combined.aborted) { controller.error(error); return; }
        const result = completionError(error, requestId);
        controller.enqueue(encoder.encode('event: error\ndata: ' + JSON.stringify(result.body) + '\n\n'));
        controller.close();
      }
    },
    async cancel(reason) {
      abort.abort(reason);
      await chunks.return();
    },
  }, {highWaterMark:0});
  return new Response(stream, {headers:{...headers,'Content-Type':'text/event-stream; charset=utf-8','X-Accel-Buffering':'no'}});
}
