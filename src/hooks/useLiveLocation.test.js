import { act, renderHook } from '@testing-library/react';
import useLiveLocation from './useLiveLocation';

let success;
let failure;
let geolocation;
beforeEach(() => {
  geolocation = {
    watchPosition: jest.fn((onSuccess, onFailure) => { success = onSuccess; failure = onFailure; return 7; }),
    clearWatch: jest.fn(),
  };
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: geolocation });
});

test('starts only on request, ignores GPS jitter, and cleans up on map exit', () => {
  const onPosition = jest.fn();
  const { result, rerender } = renderHook(({ enabled }) => useLiveLocation({ enabled, onPosition }), { initialProps: { enabled: true } });
  expect(geolocation.watchPosition).not.toHaveBeenCalled();
  act(() => result.current.start());
  act(() => success({ coords: { latitude: 43.7, longitude: -79.4 } }));
  expect(result.current.status).toBe('tracking');
  expect(onPosition).toHaveBeenCalledTimes(1);
  act(() => success({ coords: { latitude: 43.70001, longitude: -79.40001 } }));
  expect(onPosition).toHaveBeenCalledTimes(1);
  rerender({ enabled: false });
  expect(geolocation.clearWatch).toHaveBeenCalledWith(7);
  act(() => success({ coords: { latitude: 43.8, longitude: -79.4 } }));
  expect(onPosition).toHaveBeenCalledTimes(1);
  expect(result.current.position).toBe(null);
});

test.each([[1, /denied/], [3, /could not be found/]])('permission and timeout failures stop tracking (%s)', (code, message) => {
  const { result } = renderHook(() => useLiveLocation({ enabled: true, onPosition: jest.fn() }));
  act(() => result.current.start());
  act(() => failure({ code }));
  expect(result.current.error).toMatch(message);
  expect(geolocation.clearWatch).toHaveBeenCalledWith(7);
  expect(result.current.position).toBe(null);
});

test('outside-area locations are never sent to the map and unmount clears the watch', () => {
  const onPosition = jest.fn();
  const { result, unmount } = renderHook(() => useLiveLocation({ enabled: true, onPosition }));
  act(() => result.current.start());
  act(() => success({ coords: { latitude: 0, longitude: 0 } }));
  expect(onPosition).not.toHaveBeenCalled();
  expect(result.current.error).toMatch(/outside/);
  act(() => result.current.start());
  unmount();
  expect(geolocation.clearWatch).toHaveBeenCalledTimes(2);
});
