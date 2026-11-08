// Bounds shared by the QQ long-poll server and its MCP client.
export const MAX_WAIT_MS=600000;
export const MAX_QUIET_MS=120000;
export const WAIT_TAIL_MS=5000;
export const WAIT_HTTP_MARGIN_MS=20000;
export function serverLongPollBudget(timeoutMs,quietMs,maxQuietMs){
  return timeoutMs+Math.min(maxQuietMs,quietMs+WAIT_TAIL_MS);
}
export function longPollClientBudget(timeoutMs){
  const value=Number(timeoutMs);
  // With no explicit timeout the client cannot know the server's configured default.
  const wait=Number.isFinite(value)&&value>0?Math.min(MAX_WAIT_MS,Math.max(5000,Math.round(value))):MAX_WAIT_MS;
  return wait+MAX_QUIET_MS+WAIT_TAIL_MS+WAIT_HTTP_MARGIN_MS;
}
export function consumedPrivateWake(st,reason,manual=false){
  return !manual&&String(reason)==='private'&&!(st.unread||[]).length&&Number(st.lastUnreadSeq||0)<=Number(st.lastReadThroughSeq||0);
}
