// Use known error codes instead of rendering database messages or blaming the
// connection for an application limit. PostgREST preserves code and hint.
export function reportLoadErrorMessage(error, fallback = 'Reports could not be loaded. Try again.') {
  const dataLimit = error?.code === 'APPRAISAL_DATA_BUDGET_EXHAUSTED'
    || (error?.code === 'APPRAISAL_STORAGE_GATEWAY'
      && error?.message?.startsWith("Today's report data budget is exhausted."));
  if (dataLimit || error?.code === 'APPRAISAL_REQUEST_BUDGET_EXHAUSTED') {
    const reset = /^\d{4}-\d{2}-\d{2}T/.test(error?.hint || '') ? new Date(error.hint) : null;
    const retry = reset && Number.isFinite(reset.getTime())
      ? `Try again after ${new Intl.DateTimeFormat('en-CA', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      }).format(reset)}.`
      : 'Try again after the daily reset at midnight UTC.';
    return `${dataLimit ? "Today's report data limit" : "Today's online request limit"} has been reached. ${retry} Your reports and files are preserved.`;
  }
  if (error?.code === 'PGRST301' || error?.code === 'PGRST303'
    || /sign-in expired|sign in to continue/i.test(error?.message || '')) {
    return 'Your sign-in expired. Sign in again to load reports.';
  }
  if (error?.code === 'APPRAISAL_STORAGE_GATEWAY') {
    return 'The report service is temporarily unavailable. Try again shortly. Your reports and files are preserved.';
  }
  return fallback;
}
