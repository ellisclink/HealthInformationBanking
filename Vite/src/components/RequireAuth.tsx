import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { currentRole, dashboardPath, isLoggedIn, type Role } from "../api";

// Wraps a page so it can only be opened while logged in (and, if `role` is given,
// only by that kind of account). Before this, every page could be opened by typing
// its URL, logged in or not.
function RequireAuth({ children, role }: { children: ReactNode; role?: Role }) {
  if (!isLoggedIn()) return <Navigate to="/" replace />;
  if (role && currentRole() !== role) return <Navigate to={dashboardPath()} replace />;
  return <>{children}</>;
}

export default RequireAuth;
