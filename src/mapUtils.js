export const COORDINATE_PRECISION = 4;
export const DISPLAY_COORDINATE_PRECISION = 6;

const coordinateKey = (appraisal) => (
  `${Number(appraisal.latitude).toFixed(DISPLAY_COORDINATE_PRECISION)},${Number(appraisal.longitude).toFixed(DISPLAY_COORDINATE_PRECISION)}`
);

/**
 * Gives coincident markers separate display positions while preserving their
 * canonical coordinates for distance, bounds, and stored property location.
 */
export function applySpiralOffset(appraisals) {
  const totals = appraisals.reduce((counts, appraisal) => {
    const key = coordinateKey(appraisal);
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());
  const seen = new Map();

  return appraisals.map((appraisal) => {
    const key = coordinateKey(appraisal);
    const locationIndex = seen.get(key) || 0;
    const locationCount = totals.get(key) || 1;
    seen.set(key, locationIndex + 1);

    if (locationIndex === 0) {
      return {
        ...appraisal,
        displayLatitude: appraisal.latitude,
        displayLongitude: appraisal.longitude,
        locationIndex,
        locationCount,
      };
    }

    const angle = (locationIndex - 1) * (137.5 * Math.PI / 180);
    const ring = Math.ceil(locationIndex / 8);
    const radius = 0.00012 * ring;

    return {
      ...appraisal,
      displayLatitude: appraisal.latitude + radius * Math.cos(angle),
      displayLongitude: appraisal.longitude + radius * Math.sin(angle),
      locationIndex,
      locationCount,
    };
  });
}
