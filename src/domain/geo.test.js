import {
  formatDistanceKm,
  getCanonicalCoordinates,
  haversineDistanceKm,
  isValidCoordinate,
} from './geo';

describe('geographic helpers', () => {
  it('accepts database and Google Maps coordinate shapes', () => {
    expect(getCanonicalCoordinates({ latitude: 43.7, longitude: -79.4 }))
      .toEqual({ latitude: 43.7, longitude: -79.4 });
    expect(getCanonicalCoordinates({ lat: () => 43.7, lng: () => -79.4 }))
      .toEqual({ latitude: 43.7, longitude: -79.4 });
  });

  it('rejects missing and out-of-range coordinates', () => {
    expect(isValidCoordinate({ latitude: 91, longitude: 0 })).toBe(false);
    expect(isValidCoordinate({ latitude: '', longitude: 0 })).toBe(false);
    expect(haversineDistanceKm(null, { latitude: 0, longitude: 0 })).toBeNull();
  });

  it('calculates distance from canonical coordinates', () => {
    expect(haversineDistanceKm(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0 }
    )).toBe(0);

    expect(haversineDistanceKm(
      { latitude: 0, longitude: 0 },
      { latitude: 1, longitude: 0 }
    )).toBeCloseTo(111.2, 1);
  });

  it('formats short and long distances without false precision', () => {
    expect(formatDistanceKm(0.42)).toBe('420 m');
    expect(formatDistanceKm(2.34)).toBe('2.3 km');
    expect(formatDistanceKm(12.6)).toBe('13 km');
  });
});
