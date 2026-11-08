import {
  DETAIL_OPERATIONS,
  isFormBusyOperation,
  transitionDetailOperation,
} from './detailOperation';

test('declares the closed operation vocabulary', () => {
  expect(DETAIL_OPERATIONS).toEqual(['idle', 'verifying', 'saving', 'archiving']);
});

test('a save walks idle → saving → verifying → saving → idle', () => {
  let operation = 'idle';
  operation = transitionDetailOperation(operation, 'saving');
  expect(operation).toBe('saving');
  operation = transitionDetailOperation(operation, 'verifying');
  expect(operation).toBe('verifying');
  operation = transitionDetailOperation(operation, 'saving');
  expect(operation).toBe('saving');
  operation = transitionDetailOperation(operation, 'idle');
  expect(operation).toBe('idle');
});

test('an aborted verify can return straight to idle', () => {
  const operation = transitionDetailOperation(
    transitionDetailOperation('idle', 'saving'),
    'verifying'
  );
  expect(transitionDetailOperation(operation, 'idle')).toBe('idle');
});

test('archiving is only reachable from idle and always returns to idle', () => {
  expect(transitionDetailOperation('idle', 'archiving')).toBe('archiving');
  expect(transitionDetailOperation('archiving', 'idle')).toBe('idle');
});

test('overlapping operations are rejected instead of stacked', () => {
  // The old encoding allowed saving && verifyingAddress && deleting to be
  // representable at once; the declared operation forbids every overlap.
  expect(() => transitionDetailOperation('saving', 'archiving')).toThrow(/Invalid detail panel operation/);
  expect(() => transitionDetailOperation('verifying', 'archiving')).toThrow(/Invalid detail panel operation/);
  expect(() => transitionDetailOperation('archiving', 'saving')).toThrow(/Invalid detail panel operation/);
  expect(() => transitionDetailOperation('archiving', 'verifying')).toThrow(/Invalid detail panel operation/);
  expect(() => transitionDetailOperation('idle', 'verifying')).toThrow(/Invalid detail panel operation/);
});

test('re-applying the current operation is a no-op', () => {
  expect(transitionDetailOperation('saving', 'saving')).toBe('saving');
  expect(transitionDetailOperation('idle', 'idle')).toBe('idle');
});

test('unknown operations fail loudly', () => {
  expect(() => transitionDetailOperation('idle', 'exploding')).toThrow(/Unknown detail panel operation/);
  expect(() => transitionDetailOperation('exploding', 'idle')).toThrow(/Unknown detail panel operation/);
});

test('form busy is exactly saving or verifying', () => {
  expect(isFormBusyOperation('idle')).toBe(false);
  expect(isFormBusyOperation('verifying')).toBe(true);
  expect(isFormBusyOperation('saving')).toBe(true);
  expect(isFormBusyOperation('archiving')).toBe(false);
});
