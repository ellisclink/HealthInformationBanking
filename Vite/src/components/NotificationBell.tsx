import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

type Notice = {
  notification_id: string;
  kind: string;
  title: string;
  message: string | null;
  link: string | null;
  action: string | null;
  read_at: string | null;
  dismissed_at: string | null;
  created_at: string;
  reminder_id: string | null;
};

const POLL_MS = 60_000;

// The medication id for "Took it" is in the link's query string (e.g. /medications?medication_id=<id>)
function medicationIdFromLink(link: string | null): string | null {
  if (!link) return null;
  const qs = link.split("?")[1];
  if (!qs) return null;
  return new URLSearchParams(qs).get("medication_id");
}

function errorText(err: unknown) {
  return err instanceof Error ? err.message : "Something went wrong";
}

function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const doseBusy = useRef<Set<string>>(new Set()); // blocks a second tap before state updates
  const [busyDose, setBusyDose] = useState<Set<string>>(new Set());
  const [doseLogged, setDoseLogged] = useState<Set<string>>(new Set());

  const refreshCount = useCallback(async () => {
    try {
      const r = await api<{ count: number }>("/notifications/count");
      setUnread(r.count || 0);
    } catch {
      // a failed background poll is not worth interrupting the page for
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ notifications: Notice[]; unread: number }>("/notifications");
      setItems(r.notifications || []);
      setUnread(r.unread || 0);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // poll the unread count every 60 seconds
  useEffect(() => {
    const first = window.setTimeout(refreshCount, 0);
    const timer = window.setInterval(refreshCount, POLL_MS);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [refreshCount]);

  // load the list whenever the panel opens
  function toggleOpen() {
    if (!open) {
      setError("");
      loadList();
    }
    setOpen(!open);
  }

  // close on outside click and on Escape
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // run one action, then refresh the list; show a plain message if it fails
  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      setError("");
    } catch (err) {
      setError(errorText(err));
    }
    await loadList();
  }

  const markRead = (id: string) =>
    run(() => api(`/notifications/${encodeURIComponent(id)}/read`, { method: "POST" }));

  const dismiss = (id: string) =>
    run(() => api(`/notifications/${encodeURIComponent(id)}`, { method: "DELETE" }));

  const snooze = (n: Notice) =>
    run(() =>
      api(`/reminders/${encodeURIComponent(String(n.reminder_id))}/snooze`, {
        method: "POST",
        body: JSON.stringify({ minutes: 15 }),
      }),
    );

  // Logging a dose is never retried automatically: the button is disabled while the request is
  // in flight, and once the dose is saved it stays hidden even if marking the item read fails.
  async function tookIt(n: Notice) {
    const id = n.notification_id;
    if (doseBusy.current.has(id) || doseLogged.has(id)) return;
    const medId = medicationIdFromLink(n.link);
    if (!medId) {
      setError("Could not tell which medication this is for");
      return;
    }
    doseBusy.current.add(id);
    setBusyDose((s) => new Set(s).add(id));
    let saved = false;
    try {
      await api(`/medications/${encodeURIComponent(medId)}/doses`, {
        method: "POST",
        body: JSON.stringify({ dose_status: "taken" }),
      });
      saved = true;
      setDoseLogged((s) => new Set(s).add(id));
      setError("");
      await api(`/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
    } catch (err) {
      setError(
        saved
          ? `Your dose was logged, but the notification could not be marked read: ${errorText(err)}`
          : errorText(err),
      );
    } finally {
      doseBusy.current.delete(id);
      setBusyDose((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
    await loadList();
  }

  const readAll = () => run(() => api("/notifications/read-all", { method: "POST" }));
  const clearRead = () => run(() => api("/notifications?read=true", { method: "DELETE" }));

  async function openItem(n: Notice) {
    if (!n.read_at) {
      try {
        await api(`/notifications/${encodeURIComponent(n.notification_id)}/read`, { method: "POST" });
      } catch (err) {
        setError(errorText(err));
        return;
      }
      refreshCount();
    }
    if (n.link) {
      setOpen(false);
      navigate(n.link);
    } else {
      await loadList();
    }
  }

  const hasRead = items.some((n) => n.read_at);
  const label = unread > 0 ? `Notifications, ${unread} unread` : "Notifications";

  return (
    <div className="notification-bell" ref={rootRef}>
      <button
        ref={toggleRef}
        type="button"
        className="notification-bell-toggle"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="notification-panel"
        onClick={toggleOpen}
      >
        <span aria-hidden="true">&#128276;</span>
        {unread > 0 && (
          <span className="notification-bell-badge" aria-hidden="true">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          id="notification-panel"
          className="notification-bell-panel"
          role="dialog"
          aria-label="Notifications"
        >
          <div className="notification-bell-head">
            <strong>Notifications</strong>
            <span className="notification-bell-bulk">
              <button type="button" className="text-button" onClick={readAll} disabled={unread === 0}>
                Mark all read
              </button>
              <button type="button" className="text-button" onClick={clearRead} disabled={!hasRead}>
                Clear read
              </button>
            </span>
          </div>

          {error && <p className="form-hint form-hint-error" role="alert">{error}</p>}

          {loading && items.length === 0 ? (
            <p className="form-hint">Loading...</p>
          ) : items.length === 0 ? (
            <p className="form-hint">No notifications.</p>
          ) : (
            <ul className="notification-bell-list">
              {items.map((n) => (
                <li
                  key={n.notification_id}
                  className={`notification-bell-item${n.read_at ? " read" : " unread"}`}
                >
                  <button
                    type="button"
                    className="notification-bell-title"
                    onClick={() => openItem(n)}
                  >
                    {n.title}
                  </button>
                  {n.message && <p className="notification-bell-message">{n.message}</p>}
                  <div className="notification-bell-actions">
                    {n.action === "log_dose" && !doseLogged.has(n.notification_id) && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busyDose.has(n.notification_id)}
                        onClick={() => tookIt(n)}
                      >
                        Took it
                      </button>
                    )}
                    {n.reminder_id && (
                      <button type="button" className="text-button" onClick={() => snooze(n)}>
                        Snooze 15 min
                      </button>
                    )}
                    {!n.read_at && (
                      <button type="button" className="text-button" onClick={() => markRead(n.notification_id)}>
                        Mark read
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-button"
                      aria-label={`Dismiss ${n.title}`}
                      onClick={() => dismiss(n.notification_id)}
                    >
                      Dismiss
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default NotificationBell;
