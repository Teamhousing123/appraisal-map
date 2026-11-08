// Declared operation machine for the report detail panel. The panel used to
// encode its in-flight work as three booleans (saving, verifyingAddress,
// deleting) plus a loose confirm flag, so combinations like `deleting &&
// editing` were representable and reachable — an archive could complete while
// the editor was open. One operation field replaces them; overlapping work is
// unrepresentable and illegal transitions throw instead of being misread.

export const DETAIL_OPERATIONS = Object.freeze(['idle', 'verifying', 'saving', 'archiving']);

// Only these transitions exist in the save/archive flows:
//   idle      → saving     handleSave starts
//   saving    → verifying  address re-verification leg inside handleSave
//   verifying → saving     verification finished, save continues
//   verifying → idle       verification failed/aborted (save finally)
//   saving    → idle       save finished
//   idle      → archiving  handleDelete starts
//   archiving → idle       archive finished
const ALLOWED_NEXT = {
  idle: ['saving', 'archiving'],
  saving: ['verifying', 'idle'],
  verifying: ['saving', 'idle'],
  archiving: ['idle'],
};

export function transitionDetailOperation(current, next) {
  if (!DETAIL_OPERATIONS.includes(current)) {
    throw new Error(`Unknown detail panel operation "${current}".`);
  }
  if (!DETAIL_OPERATIONS.includes(next)) {
    throw new Error(`Unknown detail panel operation "${next}".`);
  }
  if (current === next) return current;
  if (!ALLOWED_NEXT[current].includes(next)) {
    throw new Error(`Invalid detail panel operation transition "${current}" → "${next}".`);
  }
  return next;
}

export function isFormBusyOperation(operation) {
  return operation === 'saving' || operation === 'verifying';
}
