// Declared workspace panel machine for the map screen. The panel used to be
// encoded across seven cooperating fields (panelMode, panelOpen,
// selectedAppraisal, detailEditing, detailReturnsToPreview, workspace flags,
// manualPlacement) so invalid pairs like `manualPlacement.active &&
// panelMode !== 'add'` were representable — and reachable. One state object
// now carries a discriminated `view`; transitionWorkspacePanel is the only
// writer and assertWorkspacePanel rejects every malformed combination.

export const WORKSPACE_PANEL_MODES = Object.freeze(['nearby', 'preview', 'detail', 'add', 'compare']);
export const MANUAL_PLACEMENT_STATUSES = Object.freeze(['idle', 'placing', 'placed', 'confirmed']);

const IDLE_PLACEMENT = Object.freeze({ status: 'idle', location: null });
const IDLE_MANUAL_PLACEMENT = Object.freeze({ active: false, location: null, confirmed: false });

// Panel views:
//   { mode: 'nearby',   appraisal|null }
//   { mode: 'compare',  appraisal|null }
//   { mode: 'preview',  appraisal, editing }
//   { mode: 'detail',   appraisal, editing, returnsToPreview }
//   { mode: 'add',      appraisal|null, placement: { status, location } }
// Every view carries the selected appraisal (required on preview/detail,
// retained-or-null elsewhere) so the map marker stays highlighted when the
// panel moves to the list, compare or add views. Only explicit deselection
// (`deselect`, Back to the list, `reset-add`) clears it. Manual placement
// exists only on the add view, so leaving it ends placement by construction.
export function initialWorkspacePanel() {
  return { open: true, view: { mode: 'nearby', appraisal: null } };
}

function isAppraisal(value) {
  return Boolean(value) && typeof value === 'object' && value.id !== undefined && value.id !== null;
}

function isLocation(value) {
  return Boolean(value) && Number.isFinite(value.latitude) && Number.isFinite(value.longitude);
}

function assertRetainedAppraisal(appraisal, mode) {
  if (appraisal !== null && !isAppraisal(appraisal)) {
    throw new Error(`Workspace panel "${mode}" carries a malformed appraisal.`);
  }
}

function requireAppraisal(appraisal, context) {
  if (!isAppraisal(appraisal)) {
    throw new Error(`Workspace panel "${context}" requires an appraisal.`);
  }
}

function assertPlacement(placement) {
  if (!placement || !MANUAL_PLACEMENT_STATUSES.includes(placement.status)) {
    throw new Error(`Unknown manual placement status "${placement?.status}".`);
  }
  if ((placement.status === 'placed' || placement.status === 'confirmed') && !isLocation(placement.location)) {
    throw new Error(`Manual placement "${placement.status}" requires a pin location.`);
  }
}

export function assertWorkspacePanel(panel) {
  if (!panel || typeof panel !== 'object' || typeof panel.open !== 'boolean' || !panel.view) {
    throw new Error('Malformed workspace panel state.');
  }
  const { view } = panel;
  switch (view.mode) {
    case 'nearby':
    case 'compare':
      assertRetainedAppraisal(view.appraisal, view.mode);
      return panel;
    case 'preview':
    case 'detail':
      requireAppraisal(view.appraisal, view.mode);
      return panel;
    case 'add':
      assertRetainedAppraisal(view.appraisal, view.mode);
      assertPlacement(view.placement);
      return panel;
    default:
      throw new Error(`Unknown workspace panel mode "${view.mode}".`);
  }
}

function viewAppraisal(view) {
  return isAppraisal(view.appraisal) ? view.appraisal : null;
}

function transitionPlacement(panel, nextPlacement) {
  const { view } = panel;
  if (view.mode !== 'add') return panel;
  if (nextPlacement === view.placement) return panel;
  return assertWorkspacePanel({ ...panel, view: { ...view, placement: nextPlacement } });
}

export function transitionWorkspacePanel(panel, action) {
  assertWorkspacePanel(panel);
  const type = action?.type;
  const { view } = panel;
  let next;
  switch (type) {
    case 'nearby':
      next = { ...panel, view: { mode: 'nearby', appraisal: viewAppraisal(view) } };
      break;
    case 'open-list':
      next = { ...panel, open: true, view: { mode: 'nearby', appraisal: viewAppraisal(view) } };
      break;
    case 'deselect':
      next = { ...panel, view: { mode: 'nearby', appraisal: null } };
      break;
    case 'open-preview':
      requireAppraisal(action.appraisal, type);
      next = { ...panel, open: true, view: { mode: 'preview', appraisal: action.appraisal, editing: false } };
      break;
    case 'open-detail':
      requireAppraisal(action.appraisal, type);
      next = { ...panel, open: true, view: { mode: 'detail', appraisal: action.appraisal, editing: false, returnsToPreview: false } };
      break;
    case 'show-detail': {
      // An update result without a report falls back to the current
      // selection; with neither there is nothing to show, so stay put
      // instead of throwing inside the reducer.
      const current = viewAppraisal(view);
      const target = isAppraisal(action.appraisal) ? action.appraisal : current;
      if (!target) return panel;
      const appraisal = current && String(current.id) === String(target.id)
        ? { ...current, ...target }
        : target;
      next = {
        ...panel,
        view: {
          mode: 'detail',
          appraisal,
          editing: false,
          returnsToPreview: view.mode === 'detail' ? Boolean(view.returnsToPreview) : false,
        },
      };
      break;
    }
    case 'expand':
      if (view.mode !== 'preview') return panel;
      next = {
        ...panel,
        open: true,
        view: {
          mode: 'detail',
          appraisal: view.appraisal,
          editing: Boolean(action.editing),
          returnsToPreview: true,
        },
      };
      break;
    case 'back':
      next = view.mode === 'detail' && view.returnsToPreview
        ? { ...panel, view: { mode: 'preview', appraisal: view.appraisal, editing: view.editing } }
        : { ...panel, view: { mode: 'nearby', appraisal: null } };
      break;
    case 'add':
      next = { ...panel, open: true, view: { mode: 'add', appraisal: viewAppraisal(view), placement: IDLE_PLACEMENT } };
      break;
    case 'reset-add':
      next = { ...panel, open: true, view: { mode: 'add', appraisal: null, placement: IDLE_PLACEMENT } };
      break;
    case 'compare':
      next = { ...panel, view: { mode: 'compare', appraisal: viewAppraisal(view) } };
      break;
    case 'close':
    case 'toggle':
      // Hiding the panel retires the pin: a placement session belongs to the
      // mounted add form, so it cannot outlive it even though the add view
      // itself is kept for the next reopen.
      next = view.mode === 'add'
        ? { ...panel, open: false, view: { ...view, placement: IDLE_PLACEMENT } }
        : { ...panel, open: false };
      if (type === 'toggle' && !panel.open) next = { open: true, view: { mode: 'nearby', appraisal: viewAppraisal(view) } };
      break;
    case 'reopen':
      next = { ...panel, open: true };
      break;
    case 'set-editing':
      if (view.mode !== 'preview' && view.mode !== 'detail') return panel;
      next = { ...panel, view: { ...view, editing: Boolean(action.editing) } };
      break;
    case 'sync-selection': {
      const current = viewAppraisal(view);
      if (!isAppraisal(current)) return panel;
      const rows = Array.isArray(action.appraisals) ? action.appraisals : [];
      const match = rows.find((row) => String(row.id) === String(current.id));
      if (!match) return panel;
      next = { ...panel, view: { ...view, appraisal: match } };
      break;
    }
    case 'begin-placement':
      return transitionPlacement(panel, { status: 'placing', location: null });
    case 'cancel-placement':
      return transitionPlacement(panel, IDLE_PLACEMENT);
    case 'place-pin': {
      if (view.mode !== 'add' || view.placement.status === 'idle') return panel;
      return transitionPlacement(panel, { status: 'placed', location: action.location });
    }
    case 'confirm-placement': {
      if (view.mode !== 'add' || !isLocation(view.placement.location)) return panel;
      return transitionPlacement(panel, { status: 'confirmed', location: view.placement.location });
    }
    case 'change-pin': {
      if (view.mode !== 'add' || !isLocation(view.placement.location)) return panel;
      return transitionPlacement(panel, { status: 'placed', location: view.placement.location });
    }
    default:
      throw new Error(`Unknown workspace panel action "${type}".`);
  }
  return assertWorkspacePanel(next);
}

// Readers — every consumer derives through these so a malformed view fails
// loudly at the assert instead of rendering an inconsistent screen.
export function workspacePanelSelection(panel) {
  const { view } = assertWorkspacePanel(panel);
  return viewAppraisal(view);
}

export function workspacePanelPlacement(panel) {
  const { view } = assertWorkspacePanel(panel);
  if (view.mode !== 'add' || !view.placement) return IDLE_MANUAL_PLACEMENT;
  const { status, location } = view.placement;
  return {
    active: status !== 'idle',
    location: status === 'placed' || status === 'confirmed' ? location : null,
    confirmed: status === 'confirmed',
  };
}

export function workspacePanelDetailEditing(panel) {
  const { view } = assertWorkspacePanel(panel);
  return (view.mode === 'preview' || view.mode === 'detail') ? Boolean(view.editing) : false;
}

export function workspacePanelDetailReturnsToPreview(panel) {
  const { view } = assertWorkspacePanel(panel);
  return view.mode === 'detail' && Boolean(view.returnsToPreview);
}
