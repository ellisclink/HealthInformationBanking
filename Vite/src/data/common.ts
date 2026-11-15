// common.ts — small helpers shared by the data files (they used to keep their own identical copies).
import Parse from "../parse";

export const MAX_ROWS = 10000;   // same cap as findAll() on the server

// owner read + write, nothing public. Sent on create only; the server sets the same ACL anyway (D-019).
export function ownerAcl(): Parse.ACL {
  const acl = new Parse.ACL();
  acl.setPublicReadAccess(false);
  acl.setPublicWriteAccess(false);
  const user = Parse.User.current();
  if (user) { acl.setReadAccess(user, true); acl.setWriteAccess(user, true); }
  return acl;
}

// a value the form left empty (not sent on a create; unset on an edit)
export const isBlank = (v: unknown) => v === undefined || v === null || v === "";

// a stored text, or null when it is missing or empty
export const textOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

// a stored Date as ISO text, or null
export const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);

// a stored Date as ISO text, a non-empty text as it is, otherwise null (for columns older rows kept as text)
export const isoOrText = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" && v ? v : null);
