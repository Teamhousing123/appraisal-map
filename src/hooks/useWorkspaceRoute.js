import { useCallback, useEffect, useRef, useState } from 'react';

export function readWorkspaceRoute(hash = window.location.hash) {
  const match = /^#reports(?:\/([^/]+)(\/edit)?)?$/.exec(hash);
  let reportId = null;
  try { reportId = match?.[1] ? decodeURIComponent(match[1]) : null; } catch { /* Invalid links return to the list. */ }
  return { page: hash.startsWith('#reports') ? 'reports' : 'map', reportId, editing: Boolean(match?.[2]) };
}

// Hash navigation also works on static hosting. Keep React and browser history
// in sync, including links entered directly and Back/Forward after a refresh.
export default function useWorkspaceRoute(runAction) {
  const [hash, setHash] = useState(() => window.location.hash);
  const acceptedHash = useRef(hash);
  const guard = useRef(runAction);
  guard.current = runAction;
  const commit = useCallback((target, replace = false) => {
    const url = `${window.location.pathname}${window.location.search}${target}`;
    if (window.location.hash !== target) window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
    acceptedHash.current = target;
    setHash(target);
  }, []);
  const navigate = useCallback((target, { replace = false, confirmed = false } = {}) => {
    if (confirmed) commit(target, replace);
    else guard.current(() => commit(target, replace));
  }, [commit]);
  useEffect(() => {
    const changed = () => {
      const target = window.location.hash;
      if (target === acceptedHash.current) return;
      const previous = acceptedHash.current;
      const allowed = guard.current(() => commit(target, true));
      if (allowed === false) {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${previous}`);
      }
    };
    window.addEventListener('hashchange', changed);
    window.addEventListener('popstate', changed);
    return () => {
      window.removeEventListener('hashchange', changed);
      window.removeEventListener('popstate', changed);
    };
  }, [commit]);
  return { route: readWorkspaceRoute(hash), navigate };
}
