export function applySpiralOffset(appraisals) {
  const seen = {};
  return appraisals.map((appraisal) => {
    const key = `${appraisal.latitude.toFixed(4)},${appraisal.longitude.toFixed(4)}`;
    if (seen[key] === undefined) {
      seen[key] = 0;
      return appraisal;
    }
    seen[key] += 1;
    const count = seen[key];
    const angle = (count - 1) * (137.5 * Math.PI / 180);
    const radius = 0.0004 * Math.ceil(count / 8);
    return {
      ...appraisal,
      latitude: appraisal.latitude + radius * Math.cos(angle),
      longitude: appraisal.longitude + radius * Math.sin(angle),
    };
  });
}
