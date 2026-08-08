export const APPRAISAL_ACCESS_LEVELS = Object.freeze({
  READ_ONLY: 'read_only',
  WRITE: 'write',
});

const WRITE_ROLES = new Set(['admin', 'editor', 'writer', 'appraiser']);
const READ_ONLY_ROLES = new Set(['viewer', 'reader', 'read_only', 'readonly']);

export function getAppraisalAccess(session) {
  const rawRole = session?.user?.app_metadata?.role;
  const role = typeof rawRole === 'string' ? rawRole.trim().toLowerCase() : '';

  if (WRITE_ROLES.has(role)) {
    return Object.freeze({
      level: APPRAISAL_ACCESS_LEVELS.WRITE,
      canMutate: true,
      role,
      reason: null,
    });
  }

  const hasKnownReadOnlyRole = READ_ONLY_ROLES.has(role);
  return Object.freeze({
    level: APPRAISAL_ACCESS_LEVELS.READ_ONLY,
    canMutate: false,
    role: role || null,
    reason: hasKnownReadOnlyRole
      ? 'Your account has view-only access.'
      : 'Your account does not have an assigned editor role. Ask an administrator for access.',
  });
}

export function canMutateAppraisals(session) {
  return getAppraisalAccess(session).canMutate;
}
