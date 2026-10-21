import React, { useEffect, useRef } from 'react';

export default function DiscardChangesDialog({ onCancel, onDiscard }) {
  const dialog = useRef(null);
  useEffect(() => { dialog.current?.querySelector('button')?.focus(); }, []);
  return <div className="calm-dialog-backdrop" role="presentation">
    <section ref={dialog} className="calm-dialog am-ui" role="dialog" aria-modal="true"
      aria-labelledby="discard-dialog-title" aria-describedby="discard-dialog-copy"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
        if (event.key !== 'Tab') return;
        const controls = dialog.current.querySelectorAll('button');
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <h2 id="discard-dialog-title">Leave this form?</h2>
      <p id="discard-dialog-copy">Your unsaved entries will stay here if you continue editing.</p>
      <div className="calm-dialog__actions">
        <button type="button" className="button button--secondary" onClick={onCancel}>Continue editing</button>
        <button type="button" className="button button--primary" onClick={onDiscard}>Discard changes</button>
      </div>
    </section>
  </div>;
}
