import Parse, { parseConfig } from './parse';

// For teammate pages that call Parse.initialize(PARSE_APP_ID, PARSE_JS_KEY) themselves: the same app parse.ts uses,
// so they never point the site at a different Back4app app.
export const PARSE_APP_ID = parseConfig.appId;
export const PARSE_JS_KEY = parseConfig.jsKey;
export const PARSE_SERVER_URL = parseConfig.serverURL;

type DiaryEntry = {
  entry_id: string; entry_date: string; category: string; title: string;
  description: string | null; severity: number | null; mood: string | null;
  follow_up_needed: boolean;
};
export type DiaryInput = Omit<DiaryEntry, 'entry_id'>;
export type VitalType = {
  vital_type: string; display_name: string; default_unit: string;
  is_dual_value: boolean; value_label: string | null; secondary_label: string | null;
};
export type VitalCard = {
  vital_type: string; display_name: string; unit: string;
  value_label?: string | null; secondary_label?: string | null; decimal_places?: number;
  today: { value: number; secondary: number | null; unit: string; age_label: string; evaluation: { status: string; range: { min: number | null; max: number | null; source: string } } } | null;
  series: { bucket_start: string; value: number; secondary: number | null; reading_count?: number }[];
  change: { delta: number; direction: string } | null;
};

// ---- session (who is logged in) ----
// The login is a Parse session, kept in sessionStorage (see parse.ts), so it
// disappears when the tab closes. The name comes from the logged-in Parse user.
// Every account is a patient; Role and currentRole stay so pages can keep asking.
export type Role = 'patient';
export type Me = {
  user_id: string; email: string; name: string; role: Role;
  terms?: { current_version: string; accepted_version: string | null; needs_acceptance: boolean };
};

// Forget the login in this tab only (the server side is ended by logout(), or has
// already expired). Parse.User.logOut() would ask the server again and get an error.
export function clearSession() {
  const done = Parse.CoreManager.getUserController().removeUserFromDisk();
  localStorage.removeItem('userRole'); // left over from the old dropdown
  return done;
}
export async function logout() {
  // Parse ends the session on the server; its afterLogout trigger (Parse/cloud/lib/auth.js) writes "logout" to the
  // audit log and ends the idle-timeout record. An already-ended session just fails, so the error is ignored.
  if (Parse.User.current()) await Parse.User.logOut().catch(() => {});
  await clearSession();
}
export const isLoggedIn = () => !!Parse.User.current();
export const currentRole = (): Role => 'patient';
export const currentName = () => String(Parse.User.current()?.get('name') || '');
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept so existing callers can still pass a role
export const dashboardPath = (_role: Role = currentRole()) => '/patient-dashboard';

// Today's date in the user's time zone as YYYY-MM-DD. (toISOString() gives the
// UTC date, which is already "tomorrow" after 8pm in Florida.)
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Every request goes to ONE Cloud Code function ("api" in Parse/cloud/main.js),
// which checks the session and runs the same routes the old Node server had.
// The pages still call api('/share', { method: 'POST', body: JSON.stringify(...) }).
// Medications are not here: they use the Parse SDK through data/medications.ts (D-025).
type Reply = { status: number; error?: string; message?: string; [key: string]: unknown };

export function sessionEnded() {
  // sessions end after 30 idle minutes or 12 hours
  clearSession();
  if (window.location.pathname !== '/') window.location.assign('/');
}

async function callApi(method: string, path: string, body?: unknown): Promise<Reply> {
  const [route, qs = ''] = path.split('?');
  const query: Record<string, string> = {};
  new URLSearchParams(qs).forEach((v, k) => { query[k] = v; });
  const hadSession = !!Parse.User.current();
  let reply: Reply;
  try {
    reply = (await Parse.Cloud.run('api', { method, path: route, query, body: body ?? {} })) as Reply;
  } catch (err) {
    const e = err as { code?: number; message?: string };
    if (e.code === Parse.Error.INVALID_SESSION_TOKEN && hadSession) {
      sessionEnded();
      throw new Error('your session has ended — please log in again');
    }
    if (e.code === Parse.Error.CONNECTION_FAILED) throw new Error('Could not reach the server');
    throw new Error(e.message || 'Request failed');
  }
  if (reply.status >= 400) {
    // (no session = a login attempt with a wrong password, which should just show the error)
    if (reply.status === 401 && hadSession) sessionEnded();
    throw new Error(reply.error || reply.message || `Request failed (${reply.status})`);
  }
  return reply;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const body = typeof options.body === 'string' && options.body ? JSON.parse(options.body) : undefined;
  const reply = await callApi((options.method || 'GET').toUpperCase(), path, body);
  const { status: _status, ...data } = reply;
  void _status;
  return data as T;
}

// ---- files (lab report PDFs) ----
// Files travel as base64 inside the Cloud Code call (and are stored encrypted).

function toBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Upload a file (details go in the query string, like before)
export async function apiUpload<T>(path: string, file: Blob, extra: Record<string, unknown> = {}): Promise<T> {
  if (file.size > 8 * 1024 * 1024) throw new Error('File is too large (8 MB max)');
  const file_base64 = toBase64(await file.arrayBuffer());
  const { status: _status, ...data } = await callApi('POST', path, { ...extra, file_base64 });
  void _status;
  return data as T;
}

// Download a protected file as a Blob (e.g. to show a PDF in the page)
export async function apiFile(path: string): Promise<Blob> {
  const reply = await callApi('GET', path);
  const bin = atob(String(reply.file_base64 || ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: String(reply.content_type || 'application/pdf') });
}

// ---- shared records (read-only views opened with a share code) ----
// every new code is 'family'; 'provider' is only on old codes, which no longer open (the server answers 410)
export type ShareAudience = 'provider' | 'family';
export type ShareSection = 'record' | 'medications' | 'vitals' | 'diary';
export const SHARE_SECTIONS: { key: ShareSection; label: string }[] = [
  { key: 'record', label: 'Medical record' },
  { key: 'medications', label: 'Medications' },
  { key: 'vitals', label: 'Vital signs' },
  { key: 'diary', label: 'Health diary' },
];
export type SharedView = {
  patient_name: string;
  audience: ShareAudience;
  sections: ShareSection[];
  expires_at: string;
  record?: {
    data: Record<string, unknown>;
    updated_at: string | null;
    // current medications from the Medications tracker (basic details)
    medications?: {
      medication_name: string; medication_type: 'prescription' | 'non_prescription' | null;
      strength: string | null; strength_unit: string | null;
      dose_amount: string | null; dose_unit: string | null; frequency: string | null;
    }[];
  };
  medications?: {
    medication_name: string; brand_name: string | null; strength: string | null; strength_unit: string | null;
    dose_amount: string | null; dose_unit: string | null; frequency: string | null; instructions: string | null;
    purpose: string | null; status: string; start_date: string | null; end_date: string | null;
  }[];
  vitals?: {
    vital_type: string; display_name: string; is_dual_value: boolean;
    latest: { value_numeric: string; value_secondary: string | null; unit: string; measured_at: string };
    evaluation: { status: string };
  }[];
  diary?: {
    entry_date: string; category: string; title: string; description: string | null;
    severity: number | null; mood: string | null; follow_up_needed: boolean;
  }[];
};
