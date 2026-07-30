import { applySpiralOffset } from './mapUtils';

describe('applySpiralOffset', () => {
  it('uses canonical coordinates as display coordinates for unique records', () => {
    const appraisals = [
      { id: 'a', latitude: 43.7, longitude: -79.4 },
      { id: 'b', latitude: 43.8, longitude: -79.5 },
    ];

    expect(applySpiralOffset(appraisals)).toEqual([
      { ...appraisals[0], displayLatitude: 43.7, displayLongitude: -79.4, locationCount: 1, locationIndex: 0 },
      { ...appraisals[1], displayLatitude: 43.8, displayLongitude: -79.5, locationCount: 1, locationIndex: 0 },
    ]);
  });

  it('offsets only display coordinates for repeated locations', () => {
    const appraisals = [
      { id: 'a', latitude: 43.7, longitude: -79.4 },
      { id: 'b', latitude: 43.7, longitude: -79.4 },
    ];

    const result = applySpiralOffset(appraisals);

    expect(result[0]).toMatchObject({
      latitude: 43.7,
      longitude: -79.4,
      displayLatitude: 43.7,
      displayLongitude: -79.4,
      locationCount: 2,
      locationIndex: 0,
    });
    expect(result[1].latitude).toBe(appraisals[1].latitude);
    expect(result[1].longitude).toBe(appraisals[1].longitude);
    expect([result[1].displayLatitude, result[1].displayLongitude]).not.toEqual([
      appraisals[1].latitude,
      appraisals[1].longitude,
    ]);
    expect(result[1]).toMatchObject({ locationCount: 2, locationIndex: 1 });
  });
});
