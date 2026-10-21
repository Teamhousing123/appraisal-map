import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { GoogleMap, Marker, MarkerClusterer, useJsApiLoader } from '@react-google-maps/api';
import { supabase, supportEmail } from './supabaseClient';
import { applySpiralOffset, COORDINATE_PRECISION } from './mapUtils';
import { formatDateOnly } from './domain/dates';
import { getCanonicalCoordinates } from './domain/geo';
import { getAppraisalAccess } from './domain/access';
import {
  GEOCODING_ERROR_CODES,
  SUPPORTED_MAP_BOUNDS,
  formatCanonicalStreetAddress,
  getAddressPredictions,
  isWithinSupportedMapBounds,
  resolveAddressSuggestion,
  validateResolvedOntarioCivicAddress,
} from './domain/geocoding';
import { SERVICE_AREA } from './domain/serviceArea';
import {
  DEFAULT_FACT_FILTERS,
  countActiveFilters,
  countReportsMissingFilterData,
  filterAndSortReports,
  getReportDistanceKm,
} from './domain/filters';
import { DEFAULT_PAGE_SIZE, fetchAppraisalsInBounds, restoreAppraisal, MAX_RECORDS_PER_BOUNDS_FETCH } from './services/appraisalService';
import { recordTelemetryEvent } from './services/telemetry';
import { createProtectedFileLink, isR2StorageEnabled } from './services/cloudflareStorage';
import { describeDocument, showPendingDocument } from './services/documentLinks';
import SubjectSearch from './components/SubjectSearch';
import NearbyWorkspace from './components/NearbyWorkspace';
import AppraisalDetailPanel from './components/AppraisalDetailPanel';
import BrandLogo from './components/BrandLogo';
import ReportRecoveryWorkspace from './components/ReportRecoveryWorkspace';
import './Map.css';
import './presentation.css';

const AddAppraisal = lazy(() => import('./AddAppraisal'));

const MAP_CONTAINER_STYLE = { height: '100%', width: '100%' };
const DEFAULT_CENTER = { lat: 43.7, lng: -79.4 };
const DEFAULT_ZOOM = 9;
const MAP_IDLE_DEBOUNCE_MS = 300;
const MAX_CACHED_REGIONS = 10;
const LOADED_ROWS_MAX = 30000;
const AUTOCOMPLETE_DEBOUNCE_MS = 260;
const GOOGLE_MAP_LIBRARIES = ['places'];
const SIGNED_URL_TTL_SECONDS = isR2StorageEnabled() ? 600 : 3600;
const SIGNED_URL_REFRESH_BUFFER_MS = 60 * 1000;
const REMOTE_OPERATION_TIMEOUT_MS = 15000;
const APP_BOUNDS = SUPPORTED_MAP_BOUNDS;
const DEFAULT_FILTERS = {
  radiusKm: '',
  propertyType: '',
  dateFrom: '',
  dateTo: '',
  sortBy: 'distance',
  ...DEFAULT_FACT_FILTERS,
};

export function getServerFilters(filters = {}) {
  const serverFilters = {
    propertyType: filters.propertyType || '',
    dateFrom: filters.dateFrom || '',
    dateTo: filters.dateTo || '',
    livingAreaMin: filters.livingAreaMin || '',
    livingAreaMax: filters.livingAreaMax || '',
    includeMissingLivingArea: Boolean(filters.includeMissingLivingArea),
    frontageMin: filters.frontageMin || '',
    frontageMax: filters.frontageMax || '',
    includeMissingFrontage: Boolean(filters.includeMissingFrontage),
    garageCapacity: filters.garageCapacity || '',
  };
  const active = serverFilters.propertyType
    || serverFilters.dateFrom
    || serverFilters.dateTo
    || serverFilters.livingAreaMin
    || serverFilters.livingAreaMax
    || serverFilters.frontageMin
    || serverFilters.frontageMax
    || serverFilters.garageCapacity;
  return active ? serverFilters : null;
}
const EMPTY_WORKSPACE_STATE = { dirty: false, busy: false };
const GOOGLE_AUTH_FAILURE_EVENT = 'appraisal-map:google-auth-failure';
const NOOP = () => {};

if (typeof window !== 'undefined' && !window.gm_authFailure?.appraisalMapHandler) {
  const previousAuthFailure = window.gm_authFailure;
  const authFailureHandler = () => {
    previousAuthFailure?.();
    window.dispatchEvent(new Event(GOOGLE_AUTH_FAILURE_EVENT));
  };
  authFailureHandler.appraisalMapHandler = true;
  window.gm_authFailure = authFailureHandler;
}

const BASE_MARKER_ICON = {
  path: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z',
  fillColor: '#08746d',
  fillOpacity: 1,
  strokeColor: '#ffffff',
  strokeWeight: 2,
  scale: 1.55,
  anchor: { x: 12, y: 22 },
};

const SUBJECT_MARKER_ICON = {
  path: 'M12 1.5a10.5 10.5 0 1 0 0 21 10.5 10.5 0 0 0 0-21Zm0 5v11M6.5 12h11',
  fillColor: '#ffffff',
  fillOpacity: 1,
  strokeColor: '#b45309',
  strokeWeight: 2.6,
  scale: 1.5,
  anchor: { x: 12, y: 12 },
};

const createClusterStyle = ({ size, fill, textSize }) => ({
  textColor: '#ffffff',
  textSize,
  url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 1.5}" fill="${fill}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 3}" fill="none" stroke="#ffffff" stroke-width="1.5" opacity=".9"/>
    </svg>
  `),
  height: size,
  width: size,
  anchorText: [0, 0],
});

const CLUSTER_STYLES = [
  createClusterStyle({ size: 34, fill: '#1b8a82', textSize: 12 }),
  createClusterStyle({ size: 38, fill: '#0b746d', textSize: 12 }),
  createClusterStyle({ size: 42, fill: '#075f59', textSize: 13 }),
  createClusterStyle({ size: 46, fill: '#134a48', textSize: 13 }),
];

function MapIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18" fill="none">
      <path d="m2.75 4.5 4.5-2 5.5 2 4.5-2v13l-4.5 2-5.5-2-4.5 2v-13Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M7.25 2.5v13M12.75 4.5v13" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

const markerIconFor = ({ selected, candidate, hovered }) => ({
  ...BASE_MARKER_ICON,
  fillColor: selected ? '#173f43' : candidate ? '#0a6762' : hovered ? '#0a5d58' : '#08746d',
  strokeColor: selected || candidate ? '#f2a44a' : '#ffffff',
  strokeWeight: selected ? 3.4 : candidate ? 2.8 : 2,
  scale: selected ? 1.82 : hovered ? 1.7 : 1.55,
  zIndex: selected ? 999 : candidate ? 600 : hovered ? 500 : undefined,
});

// Keep native pointer targets stable; report-row hover supplies marker emphasis.
const AppraisalMarker = React.memo(function AppraisalMarker({
  appraisal, clusterer, selected, candidate, hovered, onMarkerClick,
}) {
  const icon = useMemo(() => markerIconFor({ selected, candidate, hovered }), [selected, candidate, hovered]);
  const position = useMemo(() => ({
    lat: appraisal.displayLatitude ?? appraisal.latitude,
    lng: appraisal.displayLongitude ?? appraisal.longitude,
  }), [appraisal]);
  const onClick = useCallback(() => onMarkerClick(appraisal), [appraisal, onMarkerClick]);
  return (
    <Marker
      clusterer={clusterer}
      noClustererRedraw
      position={position}
      icon={icon}
      zIndex={icon.zIndex}
      title={`${appraisal.address}, ${appraisal.city}${appraisal.locationCount > 1 ? ` — ${appraisal.locationCount} reports at this location` : ''}`}
      label={appraisal.locationCount > 1 && appraisal.locationIndex === 0 ? {
        text: String(appraisal.locationCount), color: '#ffffff', fontSize: '10px', fontWeight: '700',
      } : undefined}
      onClick={onClick}
    />
  );
});

const MarkerLayer = React.memo(function MarkerLayer({
  appraisals,
  selectedId,
  candidateIds,
  hoveredId,
  onMarkerClick,
}) {
  const clustererRef = useRef(null);
  // Marker mount/remove suppresses per-marker clusterer redraws via
  // noClustererRedraw; commit exactly one repaint per marker-set change so a
  // replacement costs one recluster instead of remove*repaint + add*redraw.
  useEffect(() => {
    clustererRef.current?.repaint?.();
  }, [appraisals]);
  return (
    <MarkerClusterer
      styles={CLUSTER_STYLES}
      calculator={(markers) => {
        const count = markers.length;
        let index = 1;
        if (count >= 75) index = 4;
        else if (count >= 30) index = 3;
        else if (count >= 10) index = 2;
        return { text: String(count), index, title: `${count} stored appraisal reports` };
      }}
    >
      {(clusterer) => {
        clustererRef.current = clusterer;
        return (
        <>
          {appraisals.map((appraisal) => (
              <AppraisalMarker
                key={appraisal.id}
                appraisal={appraisal}
                clusterer={clusterer}
                selected={appraisal.id === selectedId}
                candidate={candidateIds.includes(appraisal.id)}
                hovered={appraisal.id === hoveredId}
                onMarkerClick={onMarkerClick}
              />
          ))}
        </>
        );
      }}
    </MarkerClusterer>
  );
});

function boundsFromMap(map) {
  const bounds = map?.getBounds();
  if (!bounds) return null;
  const northEast = bounds.getNorthEast();
  const southWest = bounds.getSouthWest();
  return {
    north: northEast.lat(),
    south: southWest.lat(),
    east: northEast.lng(),
    west: southWest.lng(),
  };
}

function boundsKey(bounds) {
  return [bounds.north, bounds.south, bounds.east, bounds.west]
    .map((value) => value.toFixed(COORDINATE_PRECISION))
    .join('|');
}

function padBounds(bounds, ratio = 0.18) {
  const latitudePadding = (bounds.north - bounds.south) * ratio;
  const longitudePadding = (bounds.east - bounds.west) * ratio;
  return {
    north: Math.min(90, bounds.north + latitudePadding),
    south: Math.max(-90, bounds.south - latitudePadding),
    east: Math.min(180, bounds.east + longitudePadding),
    west: Math.max(-180, bounds.west - longitudePadding),
  };
}

function boundsContain(outer, inner) {
  return Boolean(
    outer
    && inner
    && outer.north >= inner.north
    && outer.south <= inner.south
    && outer.east >= inner.east
    && outer.west <= inner.west
  );
}

function boundsArea(bounds) {
  return Math.max(0, bounds.north - bounds.south) * Math.max(0, bounds.east - bounds.west);
}

// `inner` minus `cut` → up to 4 remaining rects (top/bottom/left/right strips).
function subtractBounds(inner, cut) {
  if (!cut
    || inner.west >= cut.east || inner.east <= cut.west
    || inner.south >= cut.north || inner.north <= cut.south) {
    return [inner];
  }
  const out = [];
  if (inner.north > cut.north) out.push({ north: inner.north, south: cut.north, west: inner.west, east: inner.east });
  if (inner.south < cut.south) out.push({ north: cut.south, south: inner.south, west: inner.west, east: inner.east });
  const midNorth = Math.min(inner.north, cut.north);
  const midSouth = Math.max(inner.south, cut.south);
  if (inner.west < cut.west) out.push({ north: midNorth, south: midSouth, west: inner.west, east: cut.west });
  if (inner.east > cut.east) out.push({ north: midNorth, south: midSouth, west: cut.east, east: inner.east });
  return out.filter((r) => r.north > r.south && r.east > r.west);
}

// Part of `queryBounds` not covered by any proven (non-capped) region.
function uncoveredRects(queryBounds, regions, filterKey) {
  let remaining = [queryBounds];
  for (const region of regions) {
    if (region.filterKey !== filterKey || region.truncated) continue;
    remaining = remaining.flatMap((r) => subtractBounds(r, region.bounds));
    if (!remaining.length) break;
  }
  return remaining;
}

// Matches the service ordering (created_at desc, id asc) so merged results
// look identical to a fresh fetch.
function compareReportRows(a, b) {
  const left = a.created_at || '';
  const right = b.created_at || '';
  if (left !== right) return left < right ? 1 : -1;
  return String(a.id) < String(b.id) ? -1 : (String(a.id) > String(b.id) ? 1 : 0);
}

function isAbortError(error) {
  return error?.name === 'AbortError' || /abort/i.test(error?.message || '');
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => window.clearTimeout(timer));
}

function getAddressFailurePresentation(error, fallbackMessage) {
  const message = error?.isUserFacing || error?.code === GEOCODING_ERROR_CODES.ZERO_RESULTS
    ? error?.message
    : fallbackMessage;
  return { message: message || fallbackMessage };
}

function MapView({ session, onSessionChange = NOOP, showToast = NOOP }) {
  const [appraisals, setAppraisals] = useState([]);
  const [loadingReports, setLoadingReports] = useState(false);
  const [reportsError, setReportsError] = useState('');
  const [lastSuccessfulAt, setLastSuccessfulAt] = useState(null);
  const [resultResetKey, setResultResetKey] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [metadataSupported, setMetadataSupported] = useState(null);
  const [factsSupported, setFactsSupported] = useState(null);
  const [loadProgress, setLoadProgress] = useState(null);
  const [areaTruncated, setAreaTruncated] = useState(false);
  const [serverFiltered, setServerFiltered] = useState(false);
  const [unfilteredQueryKey, setUnfilteredQueryKey] = useState(null);
  const [selectedAppraisal, setSelectedAppraisal] = useState(null);
  const [viewport, setViewport] = useState(null);
  const [detailReturnsToPreview, setDetailReturnsToPreview] = useState(false);
  const [hoveredReportId, setHoveredReportId] = useState(null);
  const [panelMode, setPanelMode] = useState('nearby');
  const [panelOpen, setPanelOpen] = useState(true);
  const [subject, setSubject] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [candidates, setCandidates] = useState([]);
  const [openingReportId, setOpeningReportId] = useState(null);
  const [workspaceState, setWorkspaceState] = useState(EMPTY_WORKSPACE_STATE);
  const [discardAction, setDiscardAction] = useState(null);
  const [manualPlacement, setManualPlacement] = useState({
    active: false,
    location: null,
    confirmed: false,
  });
  const [signingOut, setSigningOut] = useState(false);
  const [refreshingAccess, setRefreshingAccess] = useState(false);
  const [googleAuthFailed, setGoogleAuthFailed] = useState(false);
  const [reportListMode, setReportListMode] = useState(() => window.location.hash === '#reports');

  const mapRef = useRef(null);
  const mapIdleTimerRef = useRef(null);
  const mapLoadFallbackTimerRef = useRef(null);
  const autocompleteTimerRef = useRef(null);
  const autocompleteRequestRef = useRef(0);
  const autocompleteSessionTokenRef = useRef(null);
  const reportRequestRef = useRef(null);
  const pendingQueryKeyRef = useRef(null);
  const lastBoundsRef = useRef(null);
  // Recently fetched (padded) query regions. A non-capped region proves
  // coverage of its whole area; a capped region only proves its exact key.
  const successfulRegionsRef = useRef([]);
  const lastFilterKeyRef = useRef(null);
  // Every row ever fetched this session (id -> {row, filterKey}), feeding
  // delta merges. Entries are pruned to rows inside still-tracked regions.
  const loadedRowsRef = useRef(new Map());
  const hasCompleteResultRef = useRef(false);
  const localEditSinceFetchRef = useRef(false);
  const signedUrlCacheRef = useRef(new Map());
  const placeDetailsRequestRef = useRef(0);
  const workspacePanelRef = useRef(null);
  const panelReturnFocusRef = useRef(null);
  const previousPanelOpenRef = useRef(true);
  const previousPanelModeRef = useRef('nearby');
  const nearbyPositionRef = useRef({ top: 0, reportId: null, label: '', visibleCount: 60, factsOpen: false });
  const screenObserverRef = useRef(null);
  const serverFilteredRef = useRef(false);
  const areaTruncatedRef = useRef(false);
  const serverFiltersRef = useRef(null);
  const discardReturnFocusRef = useRef(null);
  const savedCameraRef = useRef(null);
  const listContextRef = useRef(null);
  const mapCanvasRef = useRef(null);
  const reportListButtonRef = useRef(null);
  const returnedFromListRef = useRef(false);

  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: process.env.REACT_APP_GOOGLE_MAPS_API_KEY,
    libraries: GOOGLE_MAP_LIBRARIES,
  });

  const access = useMemo(() => getAppraisalAccess(session), [session]);
  const canMutate = access.canMutate;
  const isAdmin = access.role === 'admin';
  const candidateIds = useMemo(() => candidates.map((candidate) => candidate.id), [candidates]);

  const focusPanelHeading = useCallback(() => {
    const heading = workspacePanelRef.current?.querySelector('h2');
    if (!heading) {
      workspacePanelRef.current?.focus({ preventScroll: true });
      return;
    }
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }, []);

  const handleWorkspaceStateChange = useCallback((nextState = EMPTY_WORKSPACE_STATE) => {
    const next = {
      dirty: Boolean(nextState.dirty),
      busy: Boolean(nextState.busy),
    };
    setWorkspaceState((current) => (
      current.dirty === next.dirty && current.busy === next.busy ? current : next
    ));
  }, []);

  const runWorkspaceAction = useCallback((action) => {
    if (workspaceState.busy) {
      showToast({
        tone: 'info',
        title: 'Saving in progress',
        message: 'Please wait for the current save to finish.',
      });
      return false;
    }
    if (workspaceState.dirty) {
      discardReturnFocusRef.current = document.activeElement;
      setDiscardAction(() => action);
      return false;
    }
    setWorkspaceState(EMPTY_WORKSPACE_STATE);
    action?.();
    return true;
  }, [showToast, workspaceState]);

  const cancelDiscard = useCallback(() => {
    setDiscardAction(null);
    window.requestAnimationFrame(() => discardReturnFocusRef.current?.focus?.());
  }, []);

  const confirmDiscard = useCallback(() => {
    const action = discardAction;
    setDiscardAction(null);
    setWorkspaceState(EMPTY_WORKSPACE_STATE);
    action?.();
  }, [discardAction]);

  const fitMapToSubjectRadius = useCallback((nextSubject, radiusKm) => {
    const map = mapRef.current;
    const numericRadius = Number(radiusKm);
    if (!map || !window.google?.maps || !Number.isFinite(numericRadius) || numericRadius <= 0) {
      return;
    }

    const latitudeDelta = numericRadius / 111;
    const longitudeScale = Math.max(
      Math.cos((nextSubject.latitude * Math.PI) / 180),
      0.2
    );
    const longitudeDelta = numericRadius / (111 * longitudeScale);
    const bounds = new window.google.maps.LatLngBounds(
      {
        lat: nextSubject.latitude - latitudeDelta,
        lng: nextSubject.longitude - longitudeDelta,
      },
      {
        lat: nextSubject.latitude + latitudeDelta,
        lng: nextSubject.longitude + longitudeDelta,
      }
    );
    map.fitBounds(bounds, 48);
  }, []);

  const mapOptions = useMemo(() => ({
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    gestureHandling: 'greedy',
    minZoom: 5,
    maxZoom: 21,
    zoomControl: true,
    streetViewControl: false,
    mapTypeControl: false,
    fullscreenControl: false,
    clickableIcons: false,
    styles: [
      { featureType: 'poi', stylers: [{ visibility: 'off' }] },
      { featureType: 'transit', stylers: [{ visibility: 'off' }] },
      { featureType: 'administrative.land_parcel', stylers: [{ visibility: 'off' }] },
      { featureType: 'administrative.neighborhood', stylers: [{ visibility: 'off' }] },
      { featureType: 'landscape.man_made', stylers: [{ visibility: 'off' }] },
      { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
      { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#d9e7ea' }] },
      { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#eef1eb' }] },
    ],
  }), []);

  const fetchReports = useCallback(async (bounds, { force = false, serverFilters = null } = {}) => {
    if (!bounds) return;
    const filterKey = JSON.stringify(serverFilters);
    const regions = successfulRegionsRef.current;
    if (!force && regions.some((r) => !r.truncated && r.filterKey === filterKey
      && boundsContain(r.bounds, bounds))) {
      setReportsError('');
      return;
    }
    const queryBounds = padBounds(bounds);
    const key = boundsKey(queryBounds);
    const queryKey = `${key}/${filterKey}`;
    if (!force && regions.some((r) => r.filterKey === filterKey
      && (r.truncated ? boundsKey(r.bounds) === key : boundsContain(r.bounds, queryBounds)))) return;
    if (!force && pendingQueryKeyRef.current === queryKey
      && !reportRequestRef.current?.signal.aborted) return;

    localEditSinceFetchRef.current = false;

    if (reportRequestRef.current) reportRequestRef.current.abort();
    const controller = new AbortController();
    reportRequestRef.current = controller;
    pendingQueryKeyRef.current = queryKey;
    setLoadingReports(true);
    setReportsError('');

    const onProgress = ({ data, count }) => {
      if (controller.signal.aborted || reportRequestRef.current !== controller) return;
      setLoadProgress({ loaded: data.length, total: count });
      // Re-rendering thousands of markers for every intermediate page made
      // completion ~7 s slower; the first page already gives the first
      // useful results while the counter keeps reporting progress.
      // Progressive rendering applies only until the first complete result
      // exists; later fetches keep the last complete results on screen and
      // replace them atomically on success.
      if (!hasCompleteResultRef.current && data.length <= DEFAULT_PAGE_SIZE) {
        setAppraisals(applySpiralOffset(data));
      }
    };
    const poolRows = (rows) => {
      const pool = loadedRowsRef.current;
      for (const row of rows) { pool.delete(row.id); pool.set(row.id, { row, filterKey }); }
      while (pool.size > LOADED_ROWS_MAX) pool.delete(pool.keys().next().value);
    };

    try {
      // When most of the padded query is already covered by proven regions,
      // fetch only the uncovered strips and merge with pooled rows instead of
      // re-downloading the whole area (the expensive path in capped areas).
      const uncovered = force ? [queryBounds] : uncoveredRects(queryBounds, regions, filterKey);
      const uncoveredArea = uncovered.reduce((area, r) => area + boundsArea(r), 0);
      const useDeltaFetch = uncovered.length > 0 && uncovered.length <= 4
        && uncoveredArea > 0 && uncoveredArea < boundsArea(queryBounds) * 0.6;

      let result;
      if (useDeltaFetch) {
        const parts = [];
        for (const rect of uncovered) {
          if (controller.signal.aborted || reportRequestRef.current !== controller) return;
          const part = await fetchAppraisalsInBounds(supabase, rect, {
            signal: controller.signal,
            filters: serverFilters,
            onProgress,
          });
          parts.push(part);
          poolRows(part.data);
        }
        const merged = [];
        for (const entry of loadedRowsRef.current.values()) {
          if (entry.filterKey !== filterKey) continue;
          const c = getCanonicalCoordinates(entry.row);
          if (c && c.latitude <= queryBounds.north && c.latitude >= queryBounds.south
            && c.longitude <= queryBounds.east && c.longitude >= queryBounds.west) {
            merged.push(entry.row);
          }
        }
        merged.sort(compareReportRows);
        const lastPart = parts[parts.length - 1] || {};
        result = {
          data: merged.slice(0, MAX_RECORDS_PER_BOUNDS_FETCH),
          truncated: parts.some((p) => p.truncated)
            || merged.length > MAX_RECORDS_PER_BOUNDS_FETCH,
          metadataSupported: lastPart.metadataSupported,
          factsSupported: lastPart.factsSupported,
        };
      } else {
        result = await fetchAppraisalsInBounds(supabase, queryBounds, {
          signal: controller.signal,
          filters: serverFilters,
          onProgress,
        });
        poolRows(result.data);
      }
      if (controller.signal.aborted || reportRequestRef.current !== controller) return;
      const nextAppraisals = applySpiralOffset(result.data);
      hasCompleteResultRef.current = true;
      setAppraisals(nextAppraisals);
      setTruncated(result.truncated);
      setMetadataSupported(result.metadataSupported);
      setFactsSupported(result.factsSupported);
      setLoadProgress(null);
      setServerFiltered(Boolean(serverFilters));
      serverFilteredRef.current = Boolean(serverFilters);
      if (!serverFilters) {
        setAreaTruncated(result.truncated);
        areaTruncatedRef.current = result.truncated;
        setUnfilteredQueryKey(key);
      }
      setCandidates((current) => current.map((candidate) => (
        nextAppraisals.find((report) => report.id === candidate.id) || candidate
      )));
      setSelectedAppraisal((current) => (
        current ? nextAppraisals.find((report) => report.id === current.id) || current : null
      ));
      // Keep a bounded history of fetched regions so revisiting recent areas
      // hits the cache instead of refetching. A capped result cannot prove
      // coverage of a smaller area — it only satisfies an identical re-query.
      lastFilterKeyRef.current = filterKey;
      const regionList = successfulRegionsRef.current;
      const existingRegionIndex = regionList.findIndex((r) => r.filterKey === filterKey
        && boundsKey(r.bounds) === key);
      if (existingRegionIndex >= 0) regionList.splice(existingRegionIndex, 1);
      regionList.push({ bounds: queryBounds, filterKey, truncated: result.truncated });
      if (regionList.length > MAX_CACHED_REGIONS) {
        regionList.splice(0, regionList.length - MAX_CACHED_REGIONS);
      }
      // Pool only needs rows inside still-tracked regions; evict the rest so
      // delta merges never miss rows that live regions claim to cover.
      const activeRegions = successfulRegionsRef.current;
      if (activeRegions.length) {
        for (const [id, entry] of loadedRowsRef.current) {
          const c = getCanonicalCoordinates(entry.row);
          if (!c || !activeRegions.some((r) => r.filterKey === entry.filterKey
            && c.latitude <= r.bounds.north && c.latitude >= r.bounds.south
            && c.longitude <= r.bounds.east && c.longitude >= r.bounds.west)) {
            loadedRowsRef.current.delete(id);
          }
        }
      }
      setLastSuccessfulAt(new Date());
      recordTelemetryEvent('map_reports_load', {
        outcome: 'success',
        online: navigator.onLine,
        resultBucket: result.data.length >= 100 ? '100_plus' : result.data.length >= 20 ? '20_99' : '0_19',
      });
    } catch (error) {
      if (isAbortError(error) || reportRequestRef.current !== controller) return;
      console.error('Could not load appraisals in map bounds', error);
      if (hasCompleteResultRef.current) {
        // Keep the last complete result on screen; it may be stale but it is
        // still the best information we have.
        setReportsError('The refresh failed. Showing the last successful results, which may be out of date.');
      } else {
        setReportsError('Check your connection and retry this map area.');
        // A partial initial page is not a last successful load — unless a
        // local edit landed mid-fetch, drop it rather than presenting it as
        // complete results.
        if (!localEditSinceFetchRef.current) setAppraisals([]);
      }
      recordTelemetryEvent('map_reports_load', {
        outcome: 'failed',
        errorCode: error?.code || 'unknown',
        online: navigator.onLine,
      });
    } finally {
      if (reportRequestRef.current === controller) {
        reportRequestRef.current = null;
        pendingQueryKeyRef.current = null;
        setLoadingReports(false);
        setLoadProgress(null);
      }
    }
  }, []);

  const refreshCurrentBounds = useCallback(() => {
    const bounds = lastBoundsRef.current || boundsFromMap(mapRef.current);
    if (!bounds) return;
    successfulRegionsRef.current = [];
    fetchReports(bounds, {
      force: true,
      serverFilters: areaTruncatedRef.current ? serverFiltersRef.current : null,
    });
  }, [fetchReports]);

  const handleMapBoundsChanged = useCallback(() => {
    if (!['nearby', 'preview'].includes(panelMode) || manualPlacement.active) return;
    if (mapIdleTimerRef.current) window.clearTimeout(mapIdleTimerRef.current);
    // Invalidate obsolete responses as soon as the camera moves, including
    // during the debounce and when the user returns to a cached viewport.
    if (reportRequestRef.current) {
      reportRequestRef.current.abort();
      reportRequestRef.current = null;
      pendingQueryKeyRef.current = null;
      setLoadingReports(false);
      setLoadProgress(null);
    }
  }, [manualPlacement.active, panelMode]);

  const handleMapIdle = useCallback(() => {
    if (mapIdleTimerRef.current) window.clearTimeout(mapIdleTimerRef.current);
    mapIdleTimerRef.current = window.setTimeout(() => {
      if (!['nearby', 'preview'].includes(panelMode) || manualPlacement.active) return;
      const bounds = boundsFromMap(mapRef.current);
      if (!bounds) return;
      const changed = !lastBoundsRef.current || boundsKey(lastBoundsRef.current) !== boundsKey(bounds);
      lastBoundsRef.current = bounds;
      const center = getCanonicalCoordinates(mapRef.current?.getCenter?.());
      setViewport((current) => current && boundsKey(current) === boundsKey(bounds)
        ? current : { ...bounds, center });
      if (changed) {
        setResultResetKey((current) => current + 1);
        nearbyPositionRef.current.top = 0;
        if (panelMode === 'nearby' && workspacePanelRef.current) workspacePanelRef.current.scrollTop = 0;
      }
      fetchReports(bounds);
    }, MAP_IDLE_DEBOUNCE_MS);
  }, [fetchReports, manualPlacement.active, panelMode]);

  useEffect(() => () => {
    if (mapIdleTimerRef.current) window.clearTimeout(mapIdleTimerRef.current);
  }, [handleMapIdle]);

  const serverFilters = useMemo(() => getServerFilters(filters), [filters]);
  const serverFilterKey = JSON.stringify(serverFilters);

  useEffect(() => {
    serverFiltersRef.current = serverFilters;
  }, [serverFilters]);

  // Returning from the report list remounts this subtree; restore the panel
  // scroll position captured when leaving and return focus to the list button.
  useEffect(() => {
    if (reportListMode || !returnedFromListRef.current) return;
    returnedFromListRef.current = false;
    if (panelMode !== 'nearby') return;
    const panel = workspacePanelRef.current;
    if (panel) panel.scrollTop = nearbyPositionRef.current.top;
    reportListButtonRef.current?.focus();
  }, [reportListMode, panelMode]);

  const handleVisibleCountChange = useCallback((count) => {
    nearbyPositionRef.current.visibleCount = count;
  }, []);

  // When an unfiltered fetch hits the display cap and an active filter is
  // expressible server-side, issue exactly one filtered refetch. Clearing the
  // filters restores the unfiltered set exactly once. Unfiltered fetches are
  // the only writers of areaTruncated/unfilteredQueryKey, so this cannot loop.
  useEffect(() => {
    const bounds = lastBoundsRef.current;
    if (!bounds) return;
    const activeServerFilters = serverFiltersRef.current;
    if (areaTruncated && activeServerFilters) {
      fetchReports(bounds, { force: true, serverFilters: activeServerFilters });
    } else if (!activeServerFilters && serverFilteredRef.current) {
      fetchReports(bounds, { force: true });
    }
  }, [serverFilterKey, areaTruncated, unfilteredQueryKey, fetchReports]);

  useEffect(() => () => {
    if (mapIdleTimerRef.current) window.clearTimeout(mapIdleTimerRef.current);
    if (mapLoadFallbackTimerRef.current) window.clearTimeout(mapLoadFallbackTimerRef.current);
    if (autocompleteTimerRef.current) window.clearTimeout(autocompleteTimerRef.current);
    if (reportRequestRef.current) reportRequestRef.current.abort();
  }, []);

  // Keep map content anchored during workspace layout transitions. Panel
  // mode changes move the canvas's leading edge while its trailing edge
  // stays put; Maps keeps the centre lat/lng fixed across the resize, so
  // markers visibly jump by half the width delta. Counter-pan by the
  // measured centre drift so the same world point stays under the same
  // screen pixel. A window resize moves the trailing edge instead — that
  // case is left alone (normal centred resize).
  useEffect(() => {
    const canvas = mapCanvasRef.current;
    if (!canvas || typeof ResizeObserver !== 'function') return undefined;
    let last = canvas.getBoundingClientRect();
    const observer = new ResizeObserver(() => {
      const box = canvas.getBoundingClientRect();
      const driftX = (box.left + box.width / 2) - (last.left + last.width / 2);
      const driftY = (box.top + box.height / 2) - (last.top + last.height / 2);
      const leadingMoved = Math.abs(box.left - last.left) > 0.5
        || Math.abs(box.top - last.top) > 0.5;
      last = box;
      if (!leadingMoved || (Math.abs(driftX) < 1 && Math.abs(driftY) < 1)) return;
      const map = mapRef.current;
      if (!map) return;
      // Wait for Maps to apply its own resize handling, then undo the drift.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => map.panBy(driftX, driftY));
      });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleGoogleAuthFailure = () => {
      setGoogleAuthFailed(true);
      recordTelemetryEvent('address_lookup', {
        outcome: 'failed',
        errorCode: 'REQUEST_DENIED',
        source: 'google',
        endpoint: 'google_places',
        googleStatus: 'REQUEST_DENIED',
      });
    };
    window.addEventListener(GOOGLE_AUTH_FAILURE_EVENT, handleGoogleAuthFailure);
    return () => window.removeEventListener(GOOGLE_AUTH_FAILURE_EVENT, handleGoogleAuthFailure);
  }, []);

  useEffect(() => {
    if (!workspaceState.dirty && !workspaceState.busy) return undefined;
    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [workspaceState]);

  useEffect(() => {
    const wasOpen = previousPanelOpenRef.current;
    previousPanelOpenRef.current = panelOpen;

    if (panelOpen && !wasOpen) {
      panelReturnFocusRef.current = document.activeElement;
      const frame = window.requestAnimationFrame(focusPanelHeading);
      return () => window.cancelAnimationFrame(frame);
    }
    if (!panelOpen && wasOpen) {
      panelReturnFocusRef.current?.focus?.({ preventScroll: true });
    }
    return undefined;
  }, [focusPanelHeading, panelOpen]);

  useEffect(() => {
    const previousMode = previousPanelModeRef.current;
    previousPanelModeRef.current = panelMode;
    if (!panelOpen) return undefined;
    const panel = workspacePanelRef.current;
    const frame = window.requestAnimationFrame(() => {
      if (!panel) return;
      if (panelMode === 'nearby' && previousMode !== 'nearby') {
        panel.scrollTop = nearbyPositionRef.current.top;
        const record = Array.from(panel.querySelectorAll('[data-report-id]')).find((element) => String(element.dataset.reportId) === String(nearbyPositionRef.current.reportId));
        const target = Array.from(record?.querySelectorAll('button,input') || []).find((element) => element.getAttribute('aria-label') === nearbyPositionRef.current.label || element.textContent.trim() === nearbyPositionRef.current.label);
        if (target) target.focus({ preventScroll: true });
        else focusPanelHeading();
      } else if (previousMode !== panelMode) {
        panel.scrollTop = 0;
        focusPanelHeading();
      }
    });
    // The Add screen is lazy: wait for its real heading, not its loading placeholder.
    if (panel && panelMode === 'add') {
      screenObserverRef.current = new MutationObserver(() => {
        if (panel.querySelector('#add-appraisal-title')) {
          focusPanelHeading();
          screenObserverRef.current?.disconnect();
        }
      });
      screenObserverRef.current.observe(panel, { childList: true, subtree: true });
    }
    return () => { window.cancelAnimationFrame(frame); screenObserverRef.current?.disconnect(); };
  }, [focusPanelHeading, panelMode, panelOpen]);

  const distanceOrigin = useMemo(() => subject || viewport?.center || (viewport ? {
    latitude: (viewport.north + viewport.south) / 2,
    longitude: (viewport.east + viewport.west) / 2,
  } : null), [subject, viewport]);
  const derivedReportCacheRef = useRef(new WeakMap());
  const preparedReports = useMemo(() => {
    const cache = derivedReportCacheRef.current;
    const originKey = distanceOrigin
      ? `${distanceOrigin.latitude},${distanceOrigin.longitude}`
      : '';
    const out = [];
    for (const report of appraisals) {
      let derived = cache.get(report);
      if (!derived) {
        derived = {
          canonical: getCanonicalCoordinates(report),
          effectiveDate: formatDateOnly(report.effective_date),
          reportDate: formatDateOnly(report.appraisal_date),
          byOrigin: new Map(),
        };
        cache.set(report, derived);
      }
      if (viewport) {
        const c = derived.canonical;
        if (!c || c.latitude < viewport.south || c.latitude > viewport.north
          || c.longitude < viewport.west || c.longitude > viewport.east) continue;
      }
      let prepared = derived.byOrigin.get(originKey);
      if (!prepared) {
        if (derived.byOrigin.size >= 8) derived.byOrigin.clear();
        prepared = {
          ...report,
          _distanceKm: distanceOrigin ? getReportDistanceKm(report, distanceOrigin) : null,
          _formattedEffectiveDate: derived.effectiveDate,
          _formattedReportDate: derived.reportDate,
        };
        derived.byOrigin.set(originKey, prepared);
      }
      out.push(prepared);
    }
    return out;
  }, [appraisals, distanceOrigin, viewport]);

  const filteredReports = useMemo(() => filterAndSortReports(
    preparedReports,
    filters,
    subject
  ), [filters, preparedReports, subject]);
  const missingFilterCounts = useMemo(
    () => countReportsMissingFilterData(preparedReports),
    [preparedReports]
  );
  const decoratedCandidates = useMemo(() => candidates.map((candidate) => ({
    ...candidate,
    _distanceKm: subject ? getReportDistanceKm(candidate, subject) : null,
    _formattedEffectiveDate: formatDateOnly(candidate.effective_date),
    _formattedReportDate: formatDateOnly(candidate.appraisal_date),
  })), [candidates, subject]);
  const activeFilterCount = countActiveFilters(filters);

  const getSignedUrl = useCallback(async (bucket, path, { downloadName = null, disposition = 'inline' } = {}) => {
    if (!path) return null;
    const key = `${bucket}/${path}/${disposition}`;
    const cached = signedUrlCacheRef.current.get(key);
    if (cached && cached.expiresAt - SIGNED_URL_REFRESH_BUFFER_MS > Date.now()) return cached.url;

    const { data, error } = await withTimeout(
      isR2StorageEnabled()
        ? createProtectedFileLink(supabase, bucket, path, { downloadName, disposition })
        : supabase.storage
        .from(bucket)
        .createSignedUrl(
          path,
          SIGNED_URL_TTL_SECONDS,
          disposition === 'attachment' && downloadName ? { download: downloadName } : undefined
        ),
      REMOTE_OPERATION_TIMEOUT_MS,
      'The protected report link took too long to prepare.'
    );
    if (error || !data?.signedUrl) {
      console.error(`Could not create a protected link for ${bucket}`, error);
      return null;
    }
    const expiresInSeconds = Number.isFinite(data?.expiresIn)
      ? data.expiresIn
      : SIGNED_URL_TTL_SECONDS;
    signedUrlCacheRef.current.set(key, {
      url: data.signedUrl,
      expiresAt: Date.now() + expiresInSeconds * 1000,
    });
    return data.signedUrl;
  }, []);

  const handleOpenReport = useCallback(async (report, options = {}) => {
    const { folderPath = null, action = 'open' } = typeof options === 'string'
      ? { folderPath: options }
      : options || {};
    const describe = describeDocument(report, { folderPath, action });
    if (!describe) {
      showToast({ tone: 'info', message: 'No report document is attached to this record.' });
      return;
    }

    const pendingWindow = window.open('about:blank', '_blank');
    if (pendingWindow) {
      pendingWindow.opener = null;
      showPendingDocument(pendingWindow, describe.label);
    }
    setOpeningReportId(report.id);
    try {
      const url = await getSignedUrl(describe.bucket, describe.path, {
        downloadName: describe.downloadName,
        disposition: describe.disposition,
      });
      if (!url) throw new Error('The protected report link was not returned.');
      if (pendingWindow) {
        pendingWindow.location.replace(url);
      } else {
        showToast({
          tone: 'info',
          title: `${describe.label === 'PDF' ? 'PDF' : 'Folder'} ready`,
          message: 'Your browser blocked the new tab. Use the button below to continue.',
          persistent: true,
          action: {
            label: describe.actionLabel,
            href: url,
            target: '_self',
          },
        });
      }
      recordTelemetryEvent('document_open', {
        outcome: 'success',
        documentType: describe.isFolder ? 'folder' : 'pdf',
        endpoint: 'supabase_storage',
      });
    } catch (error) {
      pendingWindow?.close();
      showToast({
        tone: 'error',
        title: 'Report not opened',
        message: 'The protected report link could not be prepared. Check your connection and try again.',
        persistent: true,
      });
      recordTelemetryEvent('document_open', {
        outcome: 'failed',
        errorCode: error?.code || 'unknown',
        documentType: describe.isFolder ? 'folder' : 'pdf',
        endpoint: 'supabase_storage',
      });
    } finally {
      setOpeningReportId(null);
    }
  }, [getSignedUrl, showToast]);

  const getPredictions = useCallback(async (value) => {
    const places = window.google?.maps?.places;
    if (!places) {
      const error = new Error('The address service is still loading. Wait a moment and try again.');
      error.code = 'SERVICE_LOADING';
      throw error;
    }
    if (!autocompleteSessionTokenRef.current && places.AutocompleteSessionToken) {
      autocompleteSessionTokenRef.current = new places.AutocompleteSessionToken();
    }
    return getAddressPredictions(value, {
      sessionToken: autocompleteSessionTokenRef.current || undefined,
      locationBias: APP_BOUNDS,
    });
  }, []);

  const requestAutocomplete = useCallback((value) => {
    if (autocompleteTimerRef.current) window.clearTimeout(autocompleteTimerRef.current);
    const requestId = ++autocompleteRequestRef.current;
    placeDetailsRequestRef.current += 1;
    setSearchBusy(false);
    setSearchTerm(value);
    setSearchError('');
    setActiveSuggestionIndex(-1);
    if (value.trim().length < 3 || !window.google?.maps?.places) {
      if (!value.trim()) autocompleteSessionTokenRef.current = null;
      setSuggestions([]);
      return;
    }

    autocompleteTimerRef.current = window.setTimeout(async () => {
      try {
        const predictions = await getPredictions(value);
        if (requestId !== autocompleteRequestRef.current) return;
        setSuggestions(predictions.slice(0, 5));
      } catch (error) {
        if (requestId !== autocompleteRequestRef.current) return;
        setSuggestions([]);
        const failure = getAddressFailurePresentation(
          error,
          'Address suggestions are temporarily unavailable.'
        );
        if (error?.code !== GEOCODING_ERROR_CODES.ZERO_RESULTS) {
          setSearchError(failure.message);
        }
        recordTelemetryEvent('address_lookup', {
          outcome: 'failed',
          errorCode: error?.code || 'unknown',
          source: 'google',
          endpoint: 'google_places',
          googleStatus: error?.googleStatus || error?.code,
        });
      }
    }, AUTOCOMPLETE_DEBOUNCE_MS);
  }, [getPredictions]);

  const resolveSuggestion = useCallback(async (suggestion, sessionToken) => {
    return resolveAddressSuggestion(suggestion, {
      map: mapRef.current,
      sessionToken,
    });
  }, []);

  const setSubjectFromSuggestion = useCallback(async (suggestion) => {
    autocompleteRequestRef.current += 1;
    const sessionToken = autocompleteSessionTokenRef.current;
    setSearchBusy(true);
    setSearchError('');
    setSuggestions([]);
    setActiveSuggestionIndex(-1);
    const requestId = ++placeDetailsRequestRef.current;
    try {
      const resolvedPlace = await resolveSuggestion(suggestion, sessionToken);
      if (requestId !== placeDetailsRequestRef.current) return;
      const place = validateResolvedOntarioCivicAddress(resolvedPlace);
      autocompleteSessionTokenRef.current = null;
      setSearchBusy(false);
      const { latitude, longitude } = place;
      if (SERVICE_AREA.mode === 'enforced' && !isWithinSupportedMapBounds(latitude, longitude)) {
        setSearchError(`Choose a subject in the ${SERVICE_AREA.name} service area.`);
        return;
      }
      const nextSubject = {
        latitude,
        longitude,
        address: place.formattedAddress || suggestion.description,
        streetAddress: formatCanonicalStreetAddress(place),
        city: place.components?.city || '',
        propertyType: '',
        reportedLivingAreaSqFt: '',
        yearBuilt: '',
      };
      runWorkspaceAction(() => {
      setSubject(nextSubject);
        setResultResetKey((current) => current + 1);
        setCandidates([]);
        setSearchTerm(nextSubject.address);
        setFilters((current) => ({ ...current, radiusKm: '', sortBy: 'distance' }));
        setPanelMode('nearby');
        setPanelOpen(true);
        fitMapToSubjectRadius(nextSubject, 10);
      });
      recordTelemetryEvent('address_lookup', {
        outcome: 'success',
        source: 'google',
        endpoint: 'google_places',
        googleStatus: 'OK',
      });
    } catch (error) {
      if (requestId !== placeDetailsRequestRef.current) return;
      autocompleteSessionTokenRef.current = null;
      setSearchBusy(false);
      const failure = getAddressFailurePresentation(
        error,
        'That location could not be set. Choose another suggested address.'
      );
      setSearchError(failure.message);
      recordTelemetryEvent('address_lookup', {
        outcome: 'failed',
        errorCode: error?.code || 'unknown',
        source: 'google',
        endpoint: 'google_places',
        googleStatus: error?.googleStatus || error?.code,
      });
    }
  }, [fitMapToSubjectRadius, resolveSuggestion, runWorkspaceAction]);

  const handleSearchSubmit = useCallback(async () => {
    if (!searchTerm.trim() || searchBusy || !window.google?.maps?.places) return;
    setResultResetKey((current) => current + 1);
    const requestId = ++autocompleteRequestRef.current;
    setSearchBusy(true);
    setSearchError('');
    try {
      const predictions = await getPredictions(searchTerm.trim());
      if (requestId !== autocompleteRequestRef.current) return;
      setSearchBusy(false);
      setSuggestions(predictions.slice(0, 5));
      setActiveSuggestionIndex(0);
      setSearchError('');
    } catch (error) {
      if (requestId !== autocompleteRequestRef.current) return;
      setSearchBusy(false);
      setSuggestions([]);
      const failure = getAddressFailurePresentation(
        error,
        'Address search is temporarily unavailable. Try again.'
      );
      setSearchError(failure.message);
      recordTelemetryEvent('address_lookup', {
        outcome: 'failed',
        errorCode: error?.code || 'unknown',
        source: 'google',
        endpoint: 'google_places',
        googleStatus: error?.googleStatus || error?.code,
      });
    }
  }, [getPredictions, searchBusy, searchTerm]);

  const clearSubject = useCallback(() => {
    runWorkspaceAction(() => {
      autocompleteRequestRef.current += 1;
      autocompleteSessionTokenRef.current = null;
      placeDetailsRequestRef.current += 1;
      setSubject(null);
      setResultResetKey((current) => current + 1);
      setSearchTerm('');
      setSuggestions([]);
      setSearchError('');
      setCandidates([]);
      setFilters(DEFAULT_FILTERS);
      setPanelMode('nearby');
    });
  }, [runWorkspaceAction]);

  const handleSubjectFactChange = useCallback((field, value) => {
    setSubject((current) => current ? { ...current, [field]: value } : current);
  }, []);

  const handleFilterChange = useCallback((field, value) => {
    setResultResetKey((current) => current + 1);
    setFilters((current) => ({ ...current, [field]: value }));
    if (field === 'radiusKm' && value && subject) {
      fitMapToSubjectRadius(subject, value);
    }
  }, [fitMapToSubjectRadius, subject]);

  const handleApplyFilters = useCallback((partial = {}) => {
    setResultResetKey((current) => current + 1);
    setFilters((current) => ({ ...current, ...partial }));
    if (partial.radiusKm && subject) {
      fitMapToSubjectRadius(subject, partial.radiusKm);
    }
  }, [fitMapToSubjectRadius, subject]);

  const handleResetFilters = useCallback(() => {
    setResultResetKey((current) => current + 1);
    setFilters(DEFAULT_FILTERS);
  }, []);

  const handleToggleCandidate = useCallback((report) => {
    if (!subject) {
      showToast({ tone: 'info', message: 'Search for a subject property before selecting candidates.' });
      return;
    }
    setCandidates((current) => {
      if (current.some((candidate) => candidate.id === report.id)) {
        return current.filter((candidate) => candidate.id !== report.id);
      }
      if (current.length >= 3) {
        showToast({ tone: 'info', message: 'Remove one selected candidate before choosing another.' });
        return current;
      }
      return [...current, report];
    });
  }, [showToast, subject]);

  const focusReportOnMap = useCallback((report) => {
    const map = mapRef.current;
    if (!map || !report) return;
    map.panTo({ lat: Number(report.latitude), lng: Number(report.longitude) });
    if ((map.getZoom?.() || 0) < 15) map.setZoom?.(15);
    window.requestAnimationFrame(() => {
      if (window.innerWidth < 760) map.panBy?.(0, 180);
      else if (panelOpen) map.panBy?.(170, 0);
    });
  }, [panelOpen]);

  const handleOpenDetails = useCallback((report) => {
    runWorkspaceAction(() => {
      setSelectedAppraisal(report);
      setDetailReturnsToPreview(false);
      setPanelMode('preview');
      setPanelOpen(true);
    });
  }, [runWorkspaceAction]);

  const handleMarkerClick = useCallback((report) => {
    handleOpenDetails(report);
  }, [handleOpenDetails]);

  const handleAdded = useCallback((result = {}) => {
    setWorkspaceState(EMPTY_WORKSPACE_STATE);
    setManualPlacement({ active: false, location: null, confirmed: false });
    listContextRef.current = null;
    localEditSinceFetchRef.current = true;
    const created = result.report || (Array.isArray(result.data) ? result.data[0] : result.data);
    if (created?.id) {
      setAppraisals((current) => applySpiralOffset([
        created,
        ...current.filter((report) => String(report.id) !== String(created.id)),
      ]));
      loadedRowsRef.current.delete(created.id);
      loadedRowsRef.current.set(created.id, { row: created, filterKey: lastFilterKeyRef.current });
      setSelectedAppraisal(result.continueAdding ? null : created);
      setPanelMode(result.continueAdding ? 'add' : 'detail');
      setPanelOpen(true);
      successfulRegionsRef.current = [];
      focusReportOnMap(created);
    } else {
      setPanelMode(result.continueAdding ? 'add' : 'nearby');
      setPanelOpen(true);
      refreshCurrentBounds();
    }
    showToast({ tone: result.tone || 'success', message: result.message || 'Appraisal saved.' });
    recordTelemetryEvent('appraisal_mutation', { outcome: 'success', operation: 'create' });
  }, [focusReportOnMap, refreshCurrentBounds, showToast]);

  const handleUpdated = useCallback((result = 'Report updated', updatedAppraisal = null) => {
    setWorkspaceState(EMPTY_WORKSPACE_STATE);
    listContextRef.current = null;
    localEditSinceFetchRef.current = true;
    const updated = updatedAppraisal || (typeof result === 'object'
      ? result.report || result.data || (result.id ? result : null)
      : null);
    if (updated?.id) {
      setAppraisals((current) => current.map((report) => (
        String(report.id) === String(updated.id) ? { ...report, ...updated } : report
      )));
      const pooled = loadedRowsRef.current.get(updated.id);
      loadedRowsRef.current.delete(updated.id);
      loadedRowsRef.current.set(updated.id, {
        row: pooled ? { ...pooled.row, ...updated } : updated,
        filterKey: lastFilterKeyRef.current,
      });
      setSelectedAppraisal((current) => current ? { ...current, ...updated } : updated);
      setCandidates((current) => current.map((candidate) => (
        String(candidate.id) === String(updated.id) ? { ...candidate, ...updated } : candidate
      )));
    }
    setPanelMode('detail');
    refreshCurrentBounds();
    showToast({
      tone: 'success',
      message: typeof result === 'string' ? result : result.message || 'Report updated.',
    });
    recordTelemetryEvent('appraisal_mutation', { outcome: 'success', operation: 'update' });
  }, [refreshCurrentBounds, showToast]);

  const handleRestoreArchived = useCallback(async function restoreArchived(archivedAppraisal) {
    if (!archivedAppraisal?.id) return;
    showToast({
      tone: 'info',
      recoveryId: String(archivedAppraisal.id),
      message: 'Restoring the archived report…',
      persistent: true,
    });
    try {
      const restoreOptions = Number.isInteger(archivedAppraisal.version)
        ? { expectedVersion: archivedAppraisal.version }
        : undefined;
      const { data, error } = restoreOptions
        ? await restoreAppraisal(supabase, archivedAppraisal.id, restoreOptions)
        : await restoreAppraisal(supabase, archivedAppraisal.id);
      if (error || !data?.id) throw error || new Error('The restored report was not returned.');

      const restored = { ...archivedAppraisal, ...data, deleted_at: null, deleted_by: null };
      reportRequestRef.current?.abort();
      listContextRef.current = null;
      localEditSinceFetchRef.current = true;
      setAppraisals((current) => applySpiralOffset([
        restored,
        ...current.filter((report) => String(report.id) !== String(restored.id)),
      ]));
      loadedRowsRef.current.delete(restored.id);
      loadedRowsRef.current.set(restored.id, { row: restored, filterKey: lastFilterKeyRef.current });
      setSelectedAppraisal(restored);
      setPanelMode('detail');
      setPanelOpen(true);
      successfulRegionsRef.current = [];
      focusReportOnMap(restored);
      showToast({ tone: 'success', recoveryId: String(archivedAppraisal.id), recoveryResolved: true, message: 'Report restored.' });
      recordTelemetryEvent('appraisal_mutation', {
        outcome: 'success',
        operation: 'restore',
        endpoint: 'supabase_database',
      });
    } catch (error) {
      showToast({
        tone: 'error',
        recoveryId: String(archivedAppraisal.id),
        title: 'Report not restored',
        message: error?.commitStatus === 'unknown'
          ? 'The restore could not be confirmed. Check your connection; retrying is safe.'
          : error?.code === 'APPRAISAL_VERSION_CONFLICT'
            ? 'This report changed after it was archived. Reload the reports before restoring it.'
            : 'The report is still archived. Check your access and try again.',
        persistent: true,
        action: {
          label: 'Try again',
          busyLabel: 'Restoring…',
          onClick: () => restoreArchived(archivedAppraisal),
        },
      });
      recordTelemetryEvent('appraisal_mutation', {
        outcome: 'failed',
        errorCode: error?.code || 'unknown',
        operation: 'restore',
        endpoint: 'supabase_database',
      });
    }
  }, [focusReportOnMap, showToast]);

  const handleDeleted = useCallback((message = 'Report removed', archivedRecord = null) => {
    setWorkspaceState(EMPTY_WORKSPACE_STATE);
    listContextRef.current = null;
    localEditSinceFetchRef.current = true;
    const archivedAppraisal = archivedRecord || selectedAppraisal;
    if (archivedAppraisal) {
      setCandidates((current) => current.filter((candidate) => candidate.id !== archivedAppraisal.id));
      setAppraisals((current) => current.filter(
        (report) => String(report.id) !== String(archivedAppraisal.id)
      ));
      loadedRowsRef.current.delete(archivedAppraisal.id);
    }
    setSelectedAppraisal(null);
    setPanelMode('nearby');
    refreshCurrentBounds();
    showToast({
      tone: 'success',
      recoveryId: archivedAppraisal?.id && canMutate ? String(archivedAppraisal.id) : null,
      title: 'Report archived',
      message: typeof message === 'string'
        ? message
        : message?.message || 'The report was archived and removed from active results.',
      persistent: Boolean(archivedAppraisal?.id && canMutate),
      action: archivedAppraisal?.id && canMutate
        ? {
          label: 'Undo archive',
          busyLabel: 'Restoring…',
          onClick: () => handleRestoreArchived(archivedAppraisal),
        }
        : null,
    });
    recordTelemetryEvent('appraisal_mutation', { outcome: 'success', operation: 'archive' });
  }, [canMutate, handleRestoreArchived, refreshCurrentBounds, selectedAppraisal, showToast]);

  const performSignOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const { error } = await withTimeout(
        supabase.auth.signOut(),
        REMOTE_OPERATION_TIMEOUT_MS,
        'Sign out took too long.'
      );
      if (error) throw error;
      recordTelemetryEvent('auth_sign_out', {
        outcome: 'success',
        online: navigator.onLine,
        endpoint: 'supabase_auth',
      });
    } catch (error) {
      showToast({
        tone: 'error',
        title: 'Still signed in',
        message: 'Sign out failed. Check your connection and try again.',
        persistent: true,
      });
      recordTelemetryEvent('auth_sign_out', {
        outcome: 'failed',
        errorCode: error?.code || 'unknown',
        online: navigator.onLine,
        endpoint: 'supabase_auth',
      });
    } finally {
      setSigningOut(false);
    }
  }, [showToast, signingOut]);

  const handleRefreshAccess = useCallback(async () => {
    if (refreshingAccess) return;
    setRefreshingAccess(true);
    try {
      const { data, error } = await withTimeout(
        supabase.auth.refreshSession(),
        REMOTE_OPERATION_TIMEOUT_MS,
        'Access refresh took too long.'
      );
      if (error || !data?.session) throw error || new Error('No refreshed session was returned.');
      onSessionChange(data.session);
      const refreshedAccess = getAppraisalAccess(data.session);
      showToast({
        tone: refreshedAccess.canMutate ? 'success' : 'info',
        title: refreshedAccess.canMutate ? 'Editing enabled' : 'Access is still view-only',
        message: refreshedAccess.canMutate
          ? 'Your updated access is ready to use.'
          : 'Ask your administrator to enable editing, then refresh access again.',
      });
    } catch {
      showToast({
        tone: 'error',
        title: 'Access could not be refreshed',
        message: 'Check your connection. If your sign-in expired, sign in again and retry.',
        persistent: true,
      });
    } finally {
      setRefreshingAccess(false);
    }
  }, [onSessionChange, refreshingAccess, showToast]);

  const handleSignOut = useCallback(() => {
    runWorkspaceAction(performSignOut);
  }, [performSignOut, runWorkspaceAction]);

  const handleRemoveCandidate = useCallback((id) => {
    setCandidates((current) => current.filter((candidate) => candidate.id !== id));
    if (candidates.length <= 1) setPanelMode('nearby');
  }, [candidates.length]);

  const beginManualPlacement = useCallback(() => {
    setManualPlacement({ active: true, location: null, confirmed: false });
    showToast({
      tone: 'info',
      title: 'Place the property pin',
      message: 'Click the exact property location on the map. You can drag the pin to adjust it.',
      persistent: true,
    });
  }, [showToast]);

  const cancelManualPlacement = useCallback(() => {
    setManualPlacement({ active: false, location: null, confirmed: false });
  }, []);

  const confirmManualPlacement = useCallback(() => {
    setManualPlacement((current) => (
      current.location ? { ...current, active: true, confirmed: true } : current
    ));
    showToast({
      tone: 'success',
      message: 'Location confirmed. Return to the form and save when ready.',
    });
  }, [showToast]);

  const changeManualPlacement = useCallback(() => {
    setManualPlacement((current) => ({ ...current, active: true, confirmed: false }));
  }, []);

  const handleMapClick = useCallback((event) => {
    if (!manualPlacement.active || !event?.latLng) return;
    const latitude = event.latLng.lat();
    const longitude = event.latLng.lng();
    if (
      SERVICE_AREA.mode === 'enforced'
      && !isWithinSupportedMapBounds(latitude, longitude)
    ) {
      showToast({
        tone: 'info',
        message: `Place the pin inside the ${SERVICE_AREA.name} service area.`,
      });
      return;
    }
    setManualPlacement({
      active: true,
      location: { latitude, longitude },
      confirmed: false,
    });
  }, [manualPlacement.active, showToast]);

  const handleManualPinDrag = useCallback((event) => {
    if (!event?.latLng) return;
    const latitude = event.latLng.lat();
    const longitude = event.latLng.lng();
    if (
      SERVICE_AREA.mode === 'enforced'
      && !isWithinSupportedMapBounds(latitude, longitude)
    ) {
      showToast({ tone: 'info', message: `Keep the pin inside ${SERVICE_AREA.name}.` });
      return;
    }
    setManualPlacement({
      active: true,
      location: { latitude, longitude },
      confirmed: false,
    });
  }, [showToast]);

  const resetMapView = useCallback(() => {
    mapRef.current?.panTo(DEFAULT_CENTER);
    mapRef.current?.setZoom(DEFAULT_ZOOM);
  }, []);

  const fitLoadedReports = useCallback(() => {
    const map = mapRef.current;
    if (!map || !window.google?.maps || appraisals.length === 0) {
      showToast({ tone: 'info', message: 'No loaded reports are available to fit on the map yet.' });
      return;
    }
    const bounds = new window.google.maps.LatLngBounds();
    appraisals.forEach((report) => bounds.extend({
      lat: Number(report.latitude),
      lng: Number(report.longitude),
    }));
    map.fitBounds(bounds, 64);
  }, [appraisals, showToast]);

  const returnToSubject = useCallback(() => {
    if (!subject) return;
    fitMapToSubjectRadius(subject, Number(filters.radiusKm) || 10);
  }, [filters.radiusKm, fitMapToSubjectRadius, subject]);

  if (loadError || googleAuthFailed || reportListMode) {
    return (
      <ReportRecoveryWorkspace onSignOut={handleSignOut}
        onShowMap={reportListMode && !loadError && !googleAuthFailed ? (snapshot) => {
          listContextRef.current = snapshot || null;
          window.location.hash = '';
          returnedFromListRef.current = true;
          setReportListMode(false);
        } : undefined}
        initialState={reportListMode ? listContextRef.current : null}
        reason={reportListMode ? 'The report list is ready.' : googleAuthFailed ? 'Google Maps is unavailable for this website.' : 'The map could not load.'} />
    );
  }

  return (
    <main className="map-app">
      <header className={`map-header am-ui${panelOpen && ['add', 'detail', 'compare'].includes(panelMode) ? ' am-header--focused' : ''}`}>
        <div className="map-brand" aria-label="Appraisal Map">
          <BrandLogo className="map-brand__logo" />
          <span className="map-brand__copy">
            <strong>Appraisal Map</strong>
            {isAdmin && (
              <small>{SERVICE_AREA.name} · {SERVICE_AREA.version}</small>
            )}
          </span>
        </div>
        <div className="am-research-search" hidden={panelOpen && ['add', 'detail', 'compare'].includes(panelMode)}>
        <SubjectSearch
          value={searchTerm}
          onChange={requestAutocomplete}
          onSubmit={handleSearchSubmit}
          suggestions={suggestions}
          activeSuggestionIndex={activeSuggestionIndex}
          onActiveSuggestionChange={(index, options = {}) => {
            setActiveSuggestionIndex(index);
            if (options.close) {
              autocompleteRequestRef.current += 1;
              setSuggestions([]);
            }
          }}
          onSuggestionSelect={setSubjectFromSuggestion}
          subject={subject}
          onClear={clearSubject}
          busy={searchBusy}
          error={searchError}
          placeholder={`Search addresses in ${SERVICE_AREA.name}`}
        />
        </div>
        <nav className="map-header__actions" aria-label="Workspace actions">
          <button ref={reportListButtonRef} type="button" className="button button--quiet" onClick={() => runWorkspaceAction(() => {
            nearbyPositionRef.current.top = workspacePanelRef.current?.scrollTop ?? nearbyPositionRef.current.top;
            const center = mapRef.current?.getCenter?.();
            if (center) {
              savedCameraRef.current = {
                center: center.toJSON(),
                zoom: mapRef.current.getZoom(),
              };
            }
            window.location.hash = 'reports';
            setReportListMode(true);
          })}>Report list</button>
          <button type="button" className="button button--secondary am-map-toggle" onClick={() => {
            runWorkspaceAction(() => {
              setPanelOpen((open) => !open);
              if (!panelOpen) setPanelMode('nearby');
            });
          }}>
            <MapIcon /><span className="am-toggle-desktop">{panelOpen ? 'Hide reports' : 'Show reports'}</span><span className="am-toggle-narrow">{panelOpen ? 'Show map' : 'Show reports'}</span>
          </button>
          {canMutate && (
            <button type="button" className="button button--primary am-add-action" onClick={() => {
              if (panelMode === 'add') return;
              runWorkspaceAction(() => {
                setPanelMode('add');
                setPanelOpen(true);
              });
            }}>
              <span aria-hidden="true">＋</span> Add appraisal
            </button>
          )}
          <button
            type="button"
            className="button button--quiet map-header__logout"
            onClick={handleSignOut}
            disabled={signingOut}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </nav>
        {!canMutate && (
          <div className="map-access-notice" role="status">
            <span>
              <strong>Your account currently has view-only access.</strong>{' '}
              Ask your administrator to enable editing.
              {supportEmail && (
                <> <a href={`mailto:${supportEmail}`}>{supportEmail}</a></>
              )}
            </span>
            <button
              type="button"
              className="button button--secondary"
              onClick={handleRefreshAccess}
              disabled={refreshingAccess}
            >
              {refreshingAccess ? 'Refreshing…' : 'Refresh access'}
            </button>
          </div>
        )}
        {isAdmin && (
          <small className="map-service-area-mobile">
            {SERVICE_AREA.name} · {SERVICE_AREA.version}
          </small>
        )}
        {isAdmin && SERVICE_AREA.configurationError && (
          <div className="map-admin-config-warning" role="alert">
            <strong>Service area configuration needs attention.</strong>
            <span>{SERVICE_AREA.configurationError}</span>
          </div>
        )}
      </header>

      <div className={`map-stage am-layout${panelOpen ? ' am-layout--reports' : ''}${panelOpen && panelMode === 'preview' ? ' am-layout--preview' : ''}${panelMode === 'compare' ? ' am-layout--compare' : ''}${panelOpen && ['add', 'detail', 'compare'].includes(panelMode) ? ' am-layout--full' : ''}${manualPlacement.active ? ' am-layout--placing' : ''}`} >
        <div className="am-map-canvas" ref={mapCanvasRef}>
        {!isLoaded ? (
          <div className="map-loading" role="status">
            <span aria-hidden="true" />
            Loading map and reports…
          </div>
        ) : (
          <GoogleMap
            mapContainerStyle={MAP_CONTAINER_STYLE}
            onLoad={(map) => {
              mapRef.current = map;
              if (savedCameraRef.current) {
                const saved = savedCameraRef.current;
                savedCameraRef.current = null;
                map.setCenter(saved.center);
                map.setZoom(saved.zoom);
                // Idle restores the visible list from cached coverage. User
                // movement can resume immediately, with no suppression window.
              }
              // Some environments never fire `idle` (seen intermittently in
              // headless Chromium); attempt one bounds fetch anyway rather than
              // sitting silently at "Showing 0 of 0".
              if (mapLoadFallbackTimerRef.current) window.clearTimeout(mapLoadFallbackTimerRef.current);
              mapLoadFallbackTimerRef.current = window.setTimeout(() => {
                mapLoadFallbackTimerRef.current = null;
                if (!lastBoundsRef.current) handleMapIdle();
              }, 6000);
            }}
            onUnmount={() => { mapRef.current = null; }}
            onIdle={handleMapIdle}
            onBoundsChanged={handleMapBoundsChanged}
            onClick={handleMapClick}
            options={mapOptions}
          >
            <MarkerLayer
              appraisals={appraisals}
              selectedId={selectedAppraisal?.id || null}
              candidateIds={candidateIds}
              hoveredId={hoveredReportId}
              onMarkerClick={manualPlacement.active ? () => {} : handleMarkerClick}
            />
            {subject && (
              <Marker
                position={{ lat: subject.latitude, lng: subject.longitude }}
                icon={SUBJECT_MARKER_ICON}
                title={`Subject property: ${subject.address}`}
                zIndex={1200}
              />
            )}
            {manualPlacement.location && (
              <Marker
                position={{
                  lat: manualPlacement.location.latitude,
                  lng: manualPlacement.location.longitude,
                }}
                draggable={!manualPlacement.confirmed}
                onDragEnd={handleManualPinDrag}
                title="Manual property location"
                zIndex={1400}
              />
            )}
          </GoogleMap>
        )}

        {isLoaded && (
          <div className="map-camera-controls" role="group" aria-label="Map view controls">
            <button type="button" onClick={resetMapView}>Reset map</button>
            <button type="button" onClick={fitLoadedReports}>Fit reports</button>
            {subject && <button type="button" onClick={returnToSubject}>Subject</button>}
          </div>
        )}

        </div>

        {manualPlacement.active && (
          <div className="manual-placement-guide" role="status">
            <div>
              <strong>
                {manualPlacement.confirmed
                  ? 'Location confirmed'
                  : manualPlacement.location ? 'Pin selected' : 'Choose the property location'}
              </strong>
              <span>
                {manualPlacement.confirmed
                  ? 'Return to the form and save, or change the pin.'
                  : manualPlacement.location
                    ? 'Drag the pin if needed, then confirm this location.'
                    : 'Click the exact property on the map.'}
              </span>
            </div>
            <div className="manual-placement-guide__actions">
              <button type="button" onClick={cancelManualPlacement}>Cancel placement</button>
              {manualPlacement.location && !manualPlacement.confirmed && (
                <button type="button" onClick={confirmManualPlacement}>Confirm this location</button>
              )}
              {manualPlacement.confirmed && (
                <button type="button" onClick={changeManualPlacement}>Change pin</button>
              )}
            </div>
          </div>
        )}

        {!panelOpen && (
          <button type="button" className="map-panel-reopen" onClick={() => setPanelOpen(true)}>
            <MapIcon /> Show {filteredReports.length} reports
          </button>
        )}

        {panelOpen && (
          <aside
            ref={workspacePanelRef}
            className={`am-ui workspace-panel workspace-panel--${panelMode}${manualPlacement.active ? ' workspace-panel--placing' : ''}`}
            aria-label="Appraisal workspace panel"
            tabIndex="-1"
            onClickCapture={(event) => {
              if (panelMode !== 'nearby') return;
              const control = event.target.closest('button,input');
              const record = control?.closest('[data-report-id]');
              nearbyPositionRef.current = {
                ...nearbyPositionRef.current,
                top: event.currentTarget.scrollTop,
                reportId: record?.dataset.reportId || null,
                label: control?.getAttribute('aria-label') || control?.textContent.trim() || '',
                factsOpen: Boolean(event.currentTarget.querySelector('.subject-facts')?.open),
              };
            }}
          >
            {panelMode === 'add' ? (
              <Suspense fallback={<div className="panel-loader" role="status">Loading form…</div>}>
                <AddAppraisal
                  onAdded={handleAdded}
                  onCancel={() => runWorkspaceAction(() => setPanelMode('nearby'))}
                  metadataSupported={metadataSupported}
                  factsSupported={factsSupported}
                  subjectAddress={subject?.streetAddress ? {
                    address: subject.streetAddress,
                    city: subject.city,
                    formattedAddress: subject.address,
                  } : null}
                  onWorkspaceStateChange={handleWorkspaceStateChange}
                  manualPlacement={manualPlacement}
                  onRequestManualPlacement={beginManualPlacement}
                  onCancelManualPlacement={cancelManualPlacement}
                />
              </Suspense>
            ) : ['preview', 'detail'].includes(panelMode) && selectedAppraisal ? (
              <AppraisalDetailPanel
                key={selectedAppraisal.id}
                appraisal={selectedAppraisal}
                getSignedUrl={getSignedUrl}
                compact={panelMode === 'preview'}
                onExpand={() => {
                  setDetailReturnsToPreview(true);
                  setPanelMode('detail');
                }}
                backToPreview={panelMode === 'detail' && detailReturnsToPreview}
                onBack={() => runWorkspaceAction(() => {
                  if (panelMode === 'detail' && detailReturnsToPreview) setPanelMode('preview');
                  else {
                    setSelectedAppraisal(null);
                    setPanelMode('nearby');
                  }
                })}
                onUpdated={handleUpdated}
                onDeleted={handleDeleted}
                onOpenReport={handleOpenReport}
                openingReportId={openingReportId}
                metadataSupported={metadataSupported}
                factsSupported={factsSupported}
                canMutate={canMutate}
                runWorkspaceAction={runWorkspaceAction}
                onWorkspaceStateChange={handleWorkspaceStateChange}
              />
            ) : null}
            <div hidden={['add', 'detail', 'preview'].includes(panelMode)}>
              <NearbyWorkspace
                subject={subject}
                onSubjectFactChange={handleSubjectFactChange}
                reports={filteredReports}
                unfilteredCount={preparedReports.length}
                loading={loadingReports}
                error={reportsError}
                lastUpdatedAt={lastSuccessfulAt}
                truncated={truncated}
                serverFiltered={serverFiltered}
                loadProgress={loadProgress}
                metadataSupported={metadataSupported}
                factsSupported={factsSupported}
                filters={filters}
                activeFilterCount={activeFilterCount}
                missingFilterCounts={missingFilterCounts}
                onFilterChange={handleFilterChange}
                onApplyFilters={handleApplyFilters}
                onResetFilters={handleResetFilters}
                onRefresh={refreshCurrentBounds}
                onClose={() => runWorkspaceAction(() => setPanelOpen(false))}
                candidateIds={candidateIds}
                candidates={decoratedCandidates}
                onToggleCandidate={handleToggleCandidate}
                onOpenDetails={handleOpenDetails}
                onOpenReport={handleOpenReport}
                openingReportId={openingReportId}
                onHoverReport={setHoveredReportId}
                initialVisibleCount={nearbyPositionRef.current.visibleCount}
                onVisibleCountChange={handleVisibleCountChange}
                resultResetKey={resultResetKey}
                view={panelMode === 'compare' ? 'compare' : 'nearby'}
                onCompare={() => {
                  if (!subject) showToast('Set a subject property before comparing reports.');
                  else setPanelMode('compare');
                }}
                onBackFromCompare={() => setPanelMode('nearby')}
                onRemoveCandidate={handleRemoveCandidate}
                onRetry={refreshCurrentBounds}
              />
            </div>
          </aside>
        )}

        {discardAction && (
          <div className="calm-dialog-backdrop" role="presentation">
            <section
              className="calm-dialog am-ui"
              role="dialog"
              aria-modal="true"
              aria-labelledby="discard-dialog-title"
              aria-describedby="discard-dialog-copy"
            >
              <h2 id="discard-dialog-title">Leave this form?</h2>
              <p id="discard-dialog-copy">Your unsaved entries will stay here if you continue editing.</p>
              <div className="calm-dialog__actions">
                <button type="button" className="button button--secondary" onClick={cancelDiscard} autoFocus>
                  Continue editing
                </button>
                <button type="button" className="button button--primary" onClick={confirmDiscard}>
                  Discard changes
                </button>
              </div>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}

export default MapView;
