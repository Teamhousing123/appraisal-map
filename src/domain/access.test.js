import { canMutateAppraisals, getAppraisalAccess } from './access';

function sessionWithRole(role) {
  return {
    user: {
      app_metadata: role === undefined ? {} : { role },
    },
  };
}

test.each(['admin', 'editor', 'writer', 'appraiser'])(
  'allows the supported writer role %s to mutate appraisals',
  (role) => {
    expect(canMutateAppraisals(sessionWithRole(role))).toBe(true);
    expect(getAppraisalAccess(sessionWithRole(role))).toMatchObject({
      canMutate: true,
      role,
      reason: null,
    });
  }
);

test.each(['viewer', 'reader', 'read_only', 'readonly', undefined, 'unexpected-role'])(
  'keeps %s read-only',
  (role) => {
    const access = getAppraisalAccess(sessionWithRole(role));
    expect(access.canMutate).toBe(false);
    expect(access.level).toBe('read_only');
    expect(access.reason).toMatch(/view-only|administrator/i);
  }
);
