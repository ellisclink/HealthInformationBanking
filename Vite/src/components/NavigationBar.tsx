import { useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { currentRole, dashboardPath, logout } from "../api";
import NotificationBell from "./NotificationBell";

// Log out after 30 minutes with no mouse/keyboard/touch activity, so a record left
// open on a shared or clinic computer doesn't stay readable. (The server also ends
// sessions after 30 idle minutes; this clears the screen at the same time.)
const IDLE_LIMIT_MS = 30 * 60 * 1000;
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"] as const;

// The role comes from the server at login. (This used to take a `userRole` prop
// and then immediately overwrite it with localStorage, so the prop did nothing.)
function NavigationBar() {
  const navigate = useNavigate();
  const userRole = currentRole();
  const moreRef = useRef<HTMLDetailsElement>(null);

  // Close the "More" menu once a link inside it is clicked.
  function closeMore() {
    if (moreRef.current) moreRef.current.open = false;
  }

  // Also close it on a click or tap outside the menu, and on Escape (focus goes back to "More").
  useEffect(() => {
    const onPointer = (e: MouseEvent | TouchEvent) => {
      const more = moreRef.current;
      if (more?.open && !more.contains(e.target as Node)) more.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      const more = moreRef.current;
      if (e.key === "Escape" && more?.open) {
        more.open = false;
        more.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  async function handleLogout(reason?: string) {
    await logout();
    navigate("/", reason ? { state: { loggedOutReason: reason } } : undefined);
  }

  useEffect(() => {
    let lastActivity = Date.now();
    const touch = () => { lastActivity = Date.now(); };
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity > IDLE_LIMIT_MS) {
        window.clearInterval(timer);
        logout().then(() => navigate("/", { state: { loggedOutReason: "You were logged out after 30 minutes of inactivity." } }));
      }
    }, 30 * 1000);
    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, touch));
      window.clearInterval(timer);
    };
  }, [navigate]);

  return (
    <nav className="navigation-bar">
      <h1>Health Information Banking</h1>

      <div className="navigation-links">
        <Link to={dashboardPath(userRole)}>Dashboard</Link>

        <Link to="/medical-records">Medical Records</Link>

        {userRole === "patient" && (
          <>
            <Link to="/medications">Medications</Link>
            <Link to="/conditions">Conditions</Link>
            <Link to="/lab-results">Lab Results</Link>
            <Link to="/vital-signs">Vital Signs</Link>
            <Link to="/calendar">Calendar</Link>
            <Link to="/documents">Documents</Link>
            <Link to="/share-records">Share Records</Link>

            <details className="nav-more" ref={moreRef}>
              <summary>More ▾</summary>
              <div className="nav-more-menu" onClick={closeMore}>
                <Link to="/pre-visit">Pre-Visit Summary</Link>
                <Link to="/emergency">Emergency Access</Link>
                <Link to="/reminders">Reminders</Link>
                <Link to="/respiratory">Breathing Devices</Link>
                <Link to="/nutrition">Nutrition</Link>
                <Link to="/health-diary">Health Diary</Link>
                <Link to="/disposal">Safe Disposal</Link>
                <Link to="/my-links">My Links</Link>
                <Link to="/settings">Settings</Link>
              </div>
            </details>
          </>
        )}

        {/* Settings lives in the More menu for patients; other roles have no More menu */}
        {userRole !== "patient" && <Link to="/settings">Settings</Link>}

        <NotificationBell />

        <button
          className="logout-button"
          type="button"
          onClick={() => handleLogout()}
        >
          Log Out
        </button>
      </div>
    </nav>
  );
}

export default NavigationBar;
