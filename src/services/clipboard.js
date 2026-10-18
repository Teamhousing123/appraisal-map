export async function copyTextToClipboard(text) {
  let failure = null;

  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    } catch (error) {
      failure = error?.name === 'NotAllowedError' ? 'denied' : 'failed';
    }
  }

  if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
    const textarea = document.createElement('textarea');
    textarea.value = String(text ?? '');
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    try {
      if (document.execCommand('copy')) return { ok: true };
      failure = failure || 'failed';
    } catch {
      failure = failure || 'failed';
    } finally {
      textarea.remove();
    }
  }

  return { ok: false, reason: failure || 'unavailable' };
}
