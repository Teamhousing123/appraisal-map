// Deterministic synthetic appraisal datasets. Seed-stable so baseline and
// experiment runs hit identical payloads.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, '..', 'data');

// Southern Ontario service bounds (src/domain/serviceArea.js defaults).
export const SERVICE_BOUNDS = Object.freeze({ north: 44.8, south: 42.8, east: -77.0, west: -81.5 });
// Default camera: zoom 9 over Toronto (43.7, -79.4). The visible window at
// that zoom is roughly 1.6 deg x 2.4 deg; the dense core below sits inside it.
export const CORE = Object.freeze({ lat: 43.65, lng: -79.38 });

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STREETS = [
  'Yonge St', 'Queen St W', 'King St E', 'Bloor St W', 'Dundas St E', 'Bay St',
  'College St', 'Eglinton Ave W', 'Danforth Ave', 'Bathurst St', 'Dufferin St',
  'Ossington Ave', 'Roncesvalles Ave', 'Spadina Ave', 'Jarvis St', 'Parliament St',
  'Broadview Ave', 'Coxwell Ave', 'Main St', 'Victoria Park Ave', 'Warden Ave',
  'Kennedy Rd', 'Markham Rd', 'Sheppard Ave E', 'Finch Ave W', 'Steeles Ave W',
  'Jane St', 'Keele St', 'Weston Rd', 'Lakeshore Blvd W', 'The Queensway',
  'Royal York Rd', 'Islington Ave', 'Kipling Ave', 'Dixie Rd', 'Hurontario St',
  'Burnhamthorpe Rd W', 'Dundas St W', 'Bristol Rd', 'Rathburn Rd', 'Ellesmere Rd',
];
const CITIES = [
  { name: 'Toronto', lat: 43.65, lng: -79.38, weight: 0.5 },
  { name: 'Mississauga', lat: 43.59, lng: -79.64, weight: 0.12 },
  { name: 'Brampton', lat: 43.68, lng: -79.76, weight: 0.08 },
  { name: 'Vaughan', lat: 43.79, lng: -79.53, weight: 0.07 },
  { name: 'Markham', lat: 43.86, lng: -79.34, weight: 0.07 },
  { name: 'Scarborough', lat: 43.77, lng: -79.25, weight: 0.07 },
  { name: 'Oakville', lat: 43.45, lng: -79.68, weight: 0.05 },
  { name: 'Richmond Hill', lat: 43.88, lng: -79.44, weight: 0.02 },
  { name: 'Aurora', lat: 44.0, lng: -79.47, weight: 0.01 },
  { name: 'Newmarket', lat: 44.06, lng: -79.46, weight: 0.01 },
];
const PROPERTY_TYPES = ['detached', 'semi_detached', 'row_townhouse', 'condominium_apartment', 'duplex_multiplex', 'other_residential'];
const GARAGE = ['none', 'single', 'double', 'triple', 'four_plus', 'other', 'not_applicable'];
const WORDS = ['sunlit', 'corner', 'family', 'renovated', 'original', 'spacious', 'quiet', 'mature', 'walkout', 'updated'];

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}
function pickCity(rng) {
  let roll = rng();
  for (const city of CITIES) {
    if (roll < city.weight) return city;
    roll -= city.weight;
  }
  return CITIES[0];
}
function maybe(rng, probability, value) {
  return rng() < probability ? value : null;
}
function isoDate(rng, startYear = 2016, endYear = 2026) {
  const start = Date.UTC(startYear, 0, 1);
  const end = Date.UTC(endYear, 9, 1);
  return new Date(start + rng() * (end - start)).toISOString();
}
function dateOnly(iso) {
  return iso ? iso.slice(0, 10) : null;
}

// ~40 % of rows cluster inside the dense Toronto core (about 4 km x 4 km),
// the rest scatter across their city's rough 8 km x 8 km patch.
function positionFor(rng, city, denseCore) {
  if (city.name === 'Toronto' && rng() < denseCore) {
    return {
      lat: CORE.lat + (rng() - 0.5) * 0.036,
      lng: CORE.lng + (rng() - 0.5) * 0.048,
    };
  }
  return {
    lat: city.lat + (rng() - 0.5) * 0.07,
    lng: city.lng + (rng() - 0.5) * 0.09,
  };
}

function makeRow(rng, index, opts) {
  const city = pickCity(rng);
  const missingCoords = rng() < opts.missingCoordinateRate;
  let position = positionFor(rng, city, opts.denseCoreRate);
  if (rng() < opts.coincidentRate && opts.coincidentAnchors.length > 0) {
    const anchor = pick(rng, opts.coincidentAnchors);
    position = { lat: anchor.lat, lng: anchor.lng };
  }
  const appraisalIso = isoDate(rng);
  const effectiveIso = rng() < 0.75 ? appraisalIso : null;
  const streetNumber = 1 + Math.floor(rng() * 2200);
  const street = pick(rng, STREETS);
  const livingArea = maybe(rng, 0.82, 650 + Math.floor(rng() * 3400));
  const frontage = maybe(rng, 0.62, Math.round((18 + rng() * 95) * 100) / 100);
  const createdIso = isoDate(rng, 2020, 2026);
  const yearBuilt = maybe(rng, 0.88, 1920 + Math.floor(rng() * 105));

  return {
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    address: `${streetNumber} ${street}`,
    city: city.name,
    latitude: missingCoords ? null : Number(position.lat.toFixed(7)),
    longitude: missingCoords ? null : Number(position.lng.toFixed(7)),
    appraisal_date: dateOnly(appraisalIso),
    photo_url: maybe(rng, 0.35, `photos/${index}.jpg`),
    pdf_url: maybe(rng, 0.72, `reports/${index}.pdf`),
    folder_files: maybe(rng, 0.18, [`folder/${index}/a.pdf`, `folder/${index}/b.pdf`]),
    created_at: createdIso,
    effective_date: dateOnly(effectiveIso),
    property_type: maybe(rng, 0.9, pick(rng, PROPERTY_TYPES)),
    reported_living_area_sq_ft: livingArea,
    year_built: yearBuilt,
    garage_capacity: maybe(rng, 0.7, pick(rng, GARAGE)),
    lot_frontage_ft: frontage,
    lot_frontage_status: frontage === null ? (rng() < 0.5 ? 'not_recorded' : 'not_applicable') : 'recorded',
    idempotency_key: `key-${index.toString(36)}-${Math.floor(rng() * 1e6).toString(36)}`,
    street_number: String(streetNumber),
    route: street.split(' ').slice(0, -1).join(' ') || street,
    locality: city.name,
    province: 'Ontario',
    postal_code: `M${Math.floor(rng() * 9)}${pick(rng, 'ABCDEFGHJKLMNPRSTVWXYZ'.split(''))} ${Math.floor(rng() * 9)}${pick(rng, 'ABCDEFGHJKLMNPRSTVWXYZ'.split(''))}${Math.floor(rng() * 9)}`,
    unit: maybe(rng, 0.2, `${1 + Math.floor(rng() * 40)}`),
    country_code: 'CA',
    formatted_address: `${streetNumber} ${street}, ${city.name}, ON M${Math.floor(rng() * 9)}A ${Math.floor(rng() * 9)}A${Math.floor(rng() * 9)}, Canada`,
    place_id: `ChIJ${Math.floor(rng() * 1e10).toString(36)}${Math.floor(rng() * 1e10).toString(36)}harness`,
    original_input: `${streetNumber} ${street.toLowerCase()} ${city.name.toLowerCase()} ontario ${pick(rng, WORDS)} listing reference ${index}`,
    address_verification_status: rng() < 0.9 ? 'verified' : 'manual',
    address_verification_provider: maybe(rng, 0.9, 'google_places'),
    address_verified_at: createdIso,
    service_area_version: 'southern-ontario-v1',
    version: 1 + Math.floor(rng() * 4),
    updated_at: createdIso,
    updated_by: maybe(rng, 0.3, USER_ID),
    deleted_at: null,
    deleted_by: null,
  };
}

const USER_ID = '11111111-1111-1111-1111-111111111111';

export function generateDataset(name, count, seed, opts = {}) {
  const options = {
    denseCoreRate: opts.denseCoreRate ?? 0.72,
    coincidentRate: opts.coincidentRate ?? 0.05,
    missingCoordinateRate: opts.missingCoordinateRate ?? 0.02,
  };
  const rng = mulberry32(seed);
  // Coincident anchors: pick a handful of downtown coordinates up front so
  // several rows share them (exercises spiral offsets + count labels).
  const anchorRng = mulberry32(seed ^ 0x9e3779b9);
  const anchors = Array.from({ length: 14 }, () => ({
    lat: CORE.lat + (anchorRng() - 0.5) * 0.03,
    lng: CORE.lng + (anchorRng() - 0.5) * 0.04,
  }));
  options.coincidentAnchors = anchors;

  const rows = [];
  for (let i = 0; i < count; i += 1) rows.push(makeRow(rng, i, options));
  // Newest-first order like created_at desc: shuffle created_at already does
  // this naturally; keep generation order for determinism.
  return { name, count: rows.length, generatedAt: 'seeded', rows };
}

const SPECS = {
  S: { count: 300, seed: 0x51ab },
  M: { count: 1300, seed: 0x51ac },
  L: { count: 3000, seed: 0x51ad },
  XL: { count: 6000, seed: 0x51ae, denseCoreRate: 0.93 },
};

export function datasetPath(name) {
  return join(DATA_DIR, `${name}.json`);
}

export function loadDataset(name) {
  const spec = SPECS[name];
  if (!spec) throw new Error(`Unknown dataset ${name}. Use one of ${Object.keys(SPECS).join(', ')}`);
  const path = datasetPath(name);
  if (!existsSync(path)) {
    mkdirSync(DATA_DIR, { recursive: true });
    const dataset = generateDataset(name, spec.count, spec.seed, spec);
    writeFileSync(path, JSON.stringify(dataset));
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const name of Object.keys(SPECS)) {
    const dataset = loadDataset(name);
    const bytes = Buffer.byteLength(JSON.stringify(dataset.rows));
    const inCore = dataset.rows.filter((r) => r.latitude && Math.abs(r.latitude - CORE.lat) < 0.02 && Math.abs(r.longitude - CORE.lng) < 0.03).length;
    console.log(`${name}: ${dataset.count} rows, ${(bytes / 1024).toFixed(0)} KiB raw, ${inCore} in dense core`);
  }
}
