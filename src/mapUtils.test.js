import { applySpiralOffset } from './mapUtils';

describe('applySpiralOffset', () => {
  test('keeps first marker coordinates unchanged', () => {
    const appraisals = [
      { id: '1', latitude: 43.7, longitude: -79.4 },
    ];

    const result = applySpiralOffset(appraisals);
    expect(result[0].latitude).toBe(43.7);
    expect(result[0].longitude).toBe(-79.4);
  });

  test('offsets overlapping markers', () => {
    const appraisals = [
      { id: '1', latitude: 43.7, longitude: -79.4 },
      { id: '2', latitude: 43.7, longitude: -79.4 },
      { id: '3', latitude: 43.7, longitude: -79.4 },
    ];

    const result = applySpiralOffset(appraisals);
    expect(result[1].latitude).not.toBe(43.7);
    expect(result[2].latitude).not.toBe(43.7);
    expect(result[2].longitude).not.toBe(-79.4);
  });
});
