// Pure error mapping for Parse SDK calls (no imports, so Node can test it).
// Codes: 209 INVALID_SESSION_TOKEN, 100 CONNECTION_FAILED, 101 OBJECT_NOT_FOUND.
export function toUserError(err: unknown): { message: string; sessionEnded: boolean } {
  const e = (typeof err === "object" && err !== null ? err : {}) as { code?: unknown; message?: unknown };
  const ended = { message: "your session has ended — please log in again", sessionEnded: true };
  if (e.code === 209) return ended;
  if (e.code === 100) return { message: "Could not reach the server", sessionEnded: false };
  // 101 is also what the triggers send when the caller has no valid session
  if (e.code === 101 && typeof e.message === "string" && /needs to be authenticated/i.test(e.message)) return ended;
  if (e.code === 101) return { message: "Not found", sessionEnded: false };
  const message = typeof e.message === "string" && e.message ? e.message : "Request failed";
  return { message, sessionEnded: false };
}
