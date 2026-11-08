import {
  assertWorkspacePanel,
  initialWorkspacePanel,
  transitionWorkspacePanel,
  workspacePanelDetailEditing,
  workspacePanelDetailReturnsToPreview,
  workspacePanelPlacement,
  workspacePanelSelection,
} from './workspacePanel';

const reportA = { id: 'report-a', address: '10 Example Road', city: 'Aurora' };
const reportB = { id: 'report-b', address: '20 Side Street', city: 'Aurora' };
const pin = { latitude: 43.8, longitude: -79.4 };

function reduce(panel, actions) {
  return actions.reduce((current, action) => transitionWorkspacePanel(current, action), panel);
}

test('starts on the nearby report list with the panel open', () => {
  const panel = initialWorkspacePanel();
  expect(panel.open).toBe(true);
  expect(panel.view).toEqual({ mode: 'nearby' });
  expect(workspacePanelSelection(panel)).toBeNull();
  expect(workspacePanelPlacement(panel)).toEqual({ active: false, location: null, confirmed: false });
});

test('manual placement only exists inside the add view', () => {
  const adding = reduce(initialWorkspacePanel(), [
    { type: 'add' },
    { type: 'begin-placement' },
    { type: 'place-pin', location: pin },
    { type: 'confirm-placement' },
  ]);
  expect(adding.view.mode).toBe('add');
  expect(workspacePanelPlacement(adding)).toEqual({ active: true, location: pin, confirmed: true });

  const backToNearby = transitionWorkspacePanel(adding, { type: 'nearby' });
  expect(backToNearby.view.mode).toBe('nearby');
  expect(workspacePanelPlacement(backToNearby)).toEqual({ active: false, location: null, confirmed: false });

  const placingAgain = reduce(backToNearby, [{ type: 'add' }, { type: 'begin-placement' }]);
  const cancelled = transitionWorkspacePanel(placingAgain, { type: 'open-list' });
  expect(workspacePanelPlacement(cancelled).active).toBe(false);
});

test('leaving add mode by any route cancels pin placement', () => {
  const placing = reduce(initialWorkspacePanel(), [
    { type: 'add' },
    { type: 'begin-placement' },
    { type: 'place-pin', location: pin },
  ]);
  expect(workspacePanelPlacement(placing).active).toBe(true);

  for (const action of [
    { type: 'nearby' },
    { type: 'open-list' },
    { type: 'open-preview', appraisal: reportA },
    { type: 'open-detail', appraisal: reportA },
    { type: 'compare' },
    { type: 'add' },
    { type: 'reset-add' },
  ]) {
    const next = transitionWorkspacePanel(placing, action);
    expect(workspacePanelPlacement(next)).toEqual({ active: false, location: null, confirmed: false });
  }
});

test('closing the panel keeps the add view but retires the pin', () => {
  const placing = reduce(initialWorkspacePanel(), [
    { type: 'add' },
    { type: 'begin-placement' },
    { type: 'place-pin', location: pin },
  ]);
  for (const action of [{ type: 'toggle' }, { type: 'close' }]) {
    const closed = transitionWorkspacePanel(placing, action);
    expect(closed.open).toBe(false);
    expect(closed.view.mode).toBe('add');
    expect(workspacePanelPlacement(closed)).toEqual({ active: false, location: null, confirmed: false });
  }
});

test('placement actions are ignored outside the add view', () => {
  const panel = initialWorkspacePanel();
  for (const action of [
    { type: 'begin-placement' },
    { type: 'place-pin', location: pin },
    { type: 'confirm-placement' },
    { type: 'change-pin' },
    { type: 'cancel-placement' },
  ]) {
    expect(transitionWorkspacePanel(panel, action)).toBe(panel);
  }
});

test('pin placement walks placing → placed → confirmed and back', () => {
  let panel = transitionWorkspacePanel(initialWorkspacePanel(), { type: 'add' });
  panel = transitionWorkspacePanel(panel, { type: 'begin-placement' });
  expect(workspacePanelPlacement(panel)).toEqual({ active: true, location: null, confirmed: false });

  // Cannot confirm before a pin exists (guarded, same as the old callsite check).
  panel = transitionWorkspacePanel(panel, { type: 'confirm-placement' });
  expect(workspacePanelPlacement(panel).confirmed).toBe(false);

  panel = transitionWorkspacePanel(panel, { type: 'place-pin', location: pin });
  expect(workspacePanelPlacement(panel)).toEqual({ active: true, location: pin, confirmed: false });

  panel = transitionWorkspacePanel(panel, { type: 'confirm-placement' });
  expect(workspacePanelPlacement(panel)).toEqual({ active: true, location: pin, confirmed: true });

  panel = transitionWorkspacePanel(panel, { type: 'change-pin' });
  expect(workspacePanelPlacement(panel)).toEqual({ active: true, location: pin, confirmed: false });

  panel = transitionWorkspacePanel(panel, { type: 'cancel-placement' });
  expect(workspacePanelPlacement(panel)).toEqual({ active: false, location: null, confirmed: false });
});

test('a dragged or re-clicked pin drops the confirmation', () => {
  let panel = reduce(initialWorkspacePanel(), [
    { type: 'add' },
    { type: 'begin-placement' },
    { type: 'place-pin', location: pin },
    { type: 'confirm-placement' },
  ]);
  const moved = { latitude: 44.0, longitude: -80.0 };
  panel = transitionWorkspacePanel(panel, { type: 'place-pin', location: moved });
  expect(workspacePanelPlacement(panel)).toEqual({ active: true, location: moved, confirmed: false });
});

test('preview and detail views require an appraisal payload', () => {
  const panel = initialWorkspacePanel();
  expect(() => transitionWorkspacePanel(panel, { type: 'open-preview' })).toThrow(/appraisal/);
  expect(() => transitionWorkspacePanel(panel, { type: 'open-detail' })).toThrow(/appraisal/);
  expect(() => transitionWorkspacePanel(panel, { type: 'show-detail' })).toThrow(/appraisal/);
});

test('preview/detail always carry a selection; nearby and compare never do', () => {
  const preview = transitionWorkspacePanel(initialWorkspacePanel(), { type: 'open-preview', appraisal: reportA });
  expect(workspacePanelSelection(preview)).toEqual(reportA);

  const detail = transitionWorkspacePanel(preview, { type: 'expand', editing: true });
  expect(detail.view.mode).toBe('detail');
  expect(workspacePanelSelection(detail)).toEqual(reportA);
  expect(workspacePanelDetailEditing(detail)).toBe(true);
  expect(workspacePanelDetailReturnsToPreview(detail)).toBe(true);

  const nearby = transitionWorkspacePanel(detail, { type: 'nearby' });
  expect(workspacePanelSelection(nearby)).toBeNull();
});

test('back returns to preview only for details opened from preview', () => {
  const preview = transitionWorkspacePanel(initialWorkspacePanel(), { type: 'open-preview', appraisal: reportA });
  const detail = transitionWorkspacePanel(preview, { type: 'expand', editing: false });
  const backToPreview = transitionWorkspacePanel(detail, { type: 'back' });
  expect(backToPreview.view.mode).toBe('preview');
  expect(workspacePanelSelection(backToPreview)).toEqual(reportA);

  const directDetail = transitionWorkspacePanel(initialWorkspacePanel(), { type: 'open-detail', appraisal: reportA });
  const backToList = transitionWorkspacePanel(directDetail, { type: 'back' });
  expect(backToList.view.mode).toBe('nearby');
});

test('open-detail defaults to viewing; editing must be requested explicitly', () => {
  const panel = transitionWorkspacePanel(initialWorkspacePanel(), { type: 'open-detail', appraisal: reportA });
  expect(panel.view.editing).toBe(false);
  expect(panel.view.returnsToPreview).toBe(false);
});

test('the panel toggle always reopens on the report list', () => {
  let panel = transitionWorkspacePanel(initialWorkspacePanel(), { type: 'open-preview', appraisal: reportA });
  panel = transitionWorkspacePanel(panel, { type: 'toggle' });
  expect(panel.open).toBe(false);
  expect(panel.view.mode).toBe('preview');

  panel = transitionWorkspacePanel(panel, { type: 'toggle' });
  expect(panel.open).toBe(true);
  expect(panel.view.mode).toBe('nearby');
});

test('reopen restores the previous view; close keeps it', () => {
  let panel = transitionWorkspacePanel(initialWorkspacePanel(), { type: 'open-preview', appraisal: reportA });
  panel = transitionWorkspacePanel(panel, { type: 'close' });
  expect(panel.open).toBe(false);
  expect(panel.view.mode).toBe('preview');
  panel = transitionWorkspacePanel(panel, { type: 'reopen' });
  expect(panel.open).toBe(true);
  expect(panel.view.mode).toBe('preview');
});

test('opening add keeps the highlighted report behind the form', () => {
  const detail = transitionWorkspacePanel(initialWorkspacePanel(), { type: 'open-detail', appraisal: reportA });
  const adding = transitionWorkspacePanel(detail, { type: 'add' });
  expect(adding.view.mode).toBe('add');
  expect(workspacePanelSelection(adding)).toEqual(reportA);
});

test('sync-selection refreshes the selected report from loaded rows', () => {
  const detail = transitionWorkspacePanel(initialWorkspacePanel(), { type: 'open-detail', appraisal: reportA });
  const refreshed = { ...reportA, year_built: 1998 };
  const next = transitionWorkspacePanel(detail, { type: 'sync-selection', appraisals: [refreshed, reportB] });
  expect(workspacePanelSelection(next)).toEqual(refreshed);

  const missing = transitionWorkspacePanel(detail, { type: 'sync-selection', appraisals: [reportB] });
  expect(workspacePanelSelection(missing)).toEqual(reportA);
});

test('set-editing only applies to views that can edit', () => {
  const preview = transitionWorkspacePanel(initialWorkspacePanel(), { type: 'open-preview', appraisal: reportA });
  const editing = transitionWorkspacePanel(preview, { type: 'set-editing', editing: true });
  expect(workspacePanelDetailEditing(editing)).toBe(true);

  const nearby = initialWorkspacePanel();
  expect(transitionWorkspacePanel(nearby, { type: 'set-editing', editing: true })).toBe(nearby);
});

test('unknown actions and malformed panel states fail loudly', () => {
  const panel = initialWorkspacePanel();
  expect(() => transitionWorkspacePanel(panel, { type: 'does-not-exist' })).toThrow(/Unknown workspace panel action/);
  expect(() => transitionWorkspacePanel(panel, {})).toThrow(/Unknown workspace panel action/);
  expect(() => assertWorkspacePanel({ open: true, view: { mode: 'detail' } })).toThrow();
  expect(() => assertWorkspacePanel({ open: true, view: { mode: 'bogus' } })).toThrow();
  expect(() => assertWorkspacePanel({ open: true, view: { mode: 'add', appraisal: null, placement: { status: 'confirmed', location: null } } })).toThrow();
});
