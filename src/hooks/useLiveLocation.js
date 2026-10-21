import { useCallback, useEffect, useRef, useState } from 'react';
import { isWithinSupportedMapBounds } from '../domain/geocoding';

export default function useLiveLocation({ enabled, onPosition }) {
  const [state, setState] = useState({ status: 'off', position: null, error: '' });
  const watch = useRef(null);
  const generation = useRef(0);
  const lastPosition = useRef(null);
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;
  const stop = useCallback(() => {
    generation.current += 1;
    if (watch.current !== null) navigator.geolocation?.clearWatch(watch.current);
    watch.current = null;
    lastPosition.current = null;
    setState({ status: 'off', position: null, error: '' });
  }, []);
  const start = useCallback(() => {
    if (!enabled || watch.current !== null) return;
    if (!navigator.geolocation) {
      setState({ status: 'error', position: null, error: 'Location is unavailable in this browser. Search for an address instead.' });
      return;
    }
    const request = ++generation.current;
    setState({ status: 'locating', position: null, error: '' });
    const fail = (error) => {
      if (request !== generation.current) return;
      stop();
      setState({ status: 'error', position: null, error: error.code === 1
        ? 'Location access was denied. Allow location for this website in browser settings, or search for an address.'
        : error.code === 'outside'
          ? 'Your location is outside the supported map area. Search for a property address instead.'
          : 'Your location could not be found. Try again or search for an address.' });
    };
    try {
      const id = navigator.geolocation.watchPosition(({ coords }) => {
        if (request !== generation.current) return;
        const position = { latitude: coords.latitude, longitude: coords.longitude };
        if (!isWithinSupportedMapBounds(position.latitude, position.longitude)) { fail({ code: 'outside' }); return; }
        const previous = lastPosition.current;
        // Ignore GPS jitter and avoid repeated map/data requests for stationary users.
        if (previous && Math.abs(previous.latitude - position.latitude) < 0.0003
          && Math.abs(previous.longitude - position.longitude) < 0.0003) return;
        lastPosition.current = position;
        setState({ status: 'tracking', position, error: '' });
        onPositionRef.current(position);
      }, fail, { enableHighAccuracy: false, timeout: 15000, maximumAge: 30000 });
      if (request === generation.current) watch.current = id;
      else navigator.geolocation.clearWatch(id);
    } catch { fail({}); }
  }, [enabled, stop]);
  useEffect(() => { if (!enabled) stop(); }, [enabled, stop]);
  useEffect(() => {
    const visibilityChanged = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => document.removeEventListener('visibilitychange', visibilityChanged);
  }, [stop]);
  useEffect(() => () => {
    generation.current += 1;
    if (watch.current !== null) navigator.geolocation?.clearWatch(watch.current);
  }, []);
  return { ...state, start, stop };
}
