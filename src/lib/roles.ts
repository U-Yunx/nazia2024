/**
 * Role helpers for the ANA24 access tiers.
 *
 * The database enforces the real rules (see `is_admin()` / `is_superadmin()`
 * in the migrations); these are the client-side mirrors so the UI can gate
 * features and hide actions the server would refuse.
 *
 *   user        — normal member (trial / subscription access)
 *   admin       — staff: full admin dashboard, but cannot manage roles
 *   superadmin  — platform owner: everything admin can do, plus role
 *                 management (grant/revoke admin & superadmin)
 */
import type { UserRole } from './types'

/** True for any role that can use admin features (admin or superadmin). */
export function isAdminRole(role: UserRole | null | undefined): boolean {
  return role === 'admin' || role === 'superadmin'
}

/** True only for the top tier that can manage roles and admins. */
export function isSuperAdminRole(role: UserRole | null | undefined): boolean {
  return role === 'superadmin'
}

export const ROLE_LABEL: Record<UserRole, string> = {
  user: 'User',
  admin: 'Admin',
  superadmin: 'Superadmin',
}
