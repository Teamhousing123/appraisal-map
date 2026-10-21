import { act, renderHook } from '@testing-library/react';
import useWorkspaceRoute, { readWorkspaceRoute } from './useWorkspaceRoute';

beforeEach(() => window.history.replaceState(null, '', '/'));

test('reads direct report and edit links and recovers malformed links', () => {
  expect(readWorkspaceRoute('#reports/id-1/edit')).toEqual({ page: 'reports', reportId: 'id-1', editing: true });
  expect(readWorkspaceRoute('#reports/%')).toEqual({ page: 'reports', reportId: null, editing: false });
  expect(readWorkspaceRoute('')).toEqual({ page: 'map', reportId: null, editing: false });
});

test('navigation updates both the screen and URL and observes browser Back/Forward events', () => {
  const { result } = renderHook(() => useWorkspaceRoute((action) => { action(); return true; }));
  act(() => result.current.navigate('#reports'));
  expect(window.location.hash).toBe('#reports');
  expect(result.current.route.page).toBe('reports');
  act(() => {
    window.history.replaceState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(result.current.route.page).toBe('map');
  act(() => {
    window.history.replaceState(null, '', '/#reports/id-1');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(result.current.route.reportId).toBe('id-1');
});

test('blocked browser navigation keeps the form URL and can complete after discard', () => {
  window.history.replaceState(null, '', '/#reports/id-1/edit');
  let pending;
  const { result } = renderHook(() => useWorkspaceRoute((action) => { pending = action; return false; }));
  act(() => {
    window.history.replaceState(null, '', '/#reports');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(result.current.route.editing).toBe(true);
  expect(window.location.hash).toBe('#reports/id-1/edit');
  act(() => pending());
  expect(result.current.route.reportId).toBe(null);
  expect(window.location.hash).toBe('#reports');
});
