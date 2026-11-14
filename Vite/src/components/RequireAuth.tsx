import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { api, isLoggedIn, type Me, type Role } from "../api";
import Parse from "../parse";
import AcceptTerms from "./AcceptTerms";

// Wraps a page so it can only be opened while logged in. Before this, every page could be opened by typing
// its URL, logged in or not. (`role` is kept so the routes read the same; every account is a patient.)
// It also checks ONCE per login that the account has agreed to the current Terms of Service and Privacy Policy
// (GET /me -> terms.needs_acceptance); if not, the agreement screen is shown instead of the page. If that check
// itself fails (no connection), the page is shown: the server still checks every request.
const agreed = new Set<string>();   // user ids confirmed in this browser tab

function RequireAuth({ children }: { children: ReactNode; role?: Role }) {
  const loggedIn = isLoggedIn();
  const uid = Parse.User.current()?.id ?? "";
  const [state, setState] = useState<"checking" | "needs" | "ok">(uid && agreed.has(uid) ? "ok" : "checking");

  useEffect(() => {
    if (!uid || agreed.has(uid)) return;
    let live = true;
    api<Me>("/me")
      .then((me) => {
        if (!live) return;
        if (me.terms?.needs_acceptance) setState("needs");
        else { agreed.add(uid); setState("ok"); }
      })
      .catch(() => { if (live) setState("ok"); });
    return () => { live = false; };
  }, [uid]);

  if (!loggedIn) return <Navigate to="/" replace />;
  if (state === "checking") return <p className="page-container" role="status">Loading…</p>;
  if (state === "needs") return <AcceptTerms onDone={() => { agreed.add(uid); setState("ok"); }} />;
  return <>{children}</>;
}

export default RequireAuth;
