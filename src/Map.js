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
import { supabase } from './supabaseClient';
import { applySpiralOffset, COORDINATE_PRECISION } from './mapUtils';
import { formatDateOnly } from './domain/dates';
import { getAppraisalAccess } from './domain/access';
import {
  GEOCODING_ERROR_CODES,
  SUPPORTED_MAP_BOUNDS,
  getAddressPredictions,
  isWithinSupportedMapBounds,
  resolveAddressSuggestion,
  validateResolvedOntarioCivicAddress,
} from './domain/geocoding';
import { SERVICE_AREA } from './domain/serviceArea';
import {
  countReportsMissingFilterData,
  filterAndSortReports,
  getReportDistanceKm,
} from './domain/filters';
import { fetchAppraisalsInBounds } from './services/appraisalService';
import { createSupportReference, recordTelemetryEvent } from './services/telemetry';
import SubjectSearch from './components/SubjectSearch';
import NearbyWorkspace from './components/NearbyWorkspace';
import AppraisalDetailPanel from './components/AppraisalDetailPanel';
import BrandLogo from './components/BrandLogo';
import './Map.css';

const AddAppraisal = lazy(() => import('./AddAppraisal'));

const MAP_CONTAINER_STYLE = { height: '100%', width: '100%' };
const DEFAULT_CENTER = { lat: 43.7, lng: -79.4 };
const DEFAULT_ZOOM = 9;
const MAP_IDLE_DEBOUNCE_MS = 300;
const AUTOCOMPLETE_DEBOUNCE_MS = 260;
const GOOGLE_MAP_LIBRARIES = ['places'];
const SIGNED_URL_TTL_SECONDS = 3600;
const SIGNED_URL_REFRESH_BUFFER_MS = 60 * 1000;
const REMOTE_OPERATION_TIMEOUT_MS = 15000;
const APP_BOUNDS = SUPPORTED_MAP_BOUNDS;
const DEFAULT_FILTERS = {
  radiusKm: '',
  propertyType: '',
  dateFrom: '',
  dateTo: '',
  sortBy: 'newest',
};
const EMPTY_WORKSPACE_STATE = { dirty: false, busy: false };
const GOOGLE_AUTH_FAILURE_EVENT = 'appraisal-map:google-auth-failure';

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

const MarkerLayer = React.memo(function MarkerLayer({
  appraisals,
  selectedId,
  candidateIds,
  hoveredId,
  onMarkerClick,
  onMarkerHover,
}) {
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
      {(clusterer) => (
        <>
          {appraisals.map((appraisal) => {
            const selected = appraisal.id === selectedId;
            const candidate = candidateIds.includes(appraisal.id);
            const hovered = appraisal.id === hoveredId;
            const icon = markerIconFor({ selected, candidate, hovered });
            return (
              <Marker
                key={appraisal.id}
                clusterer={clusterer}
                position={{
                  lat: appraisal.displayLatitude ?? appraisal.latitude,
                  lng: appraisal.displayLongitude ?? appraisal.longitude,
                }}
                icon={icon}
                zIndex={icon.zIndex}
                title={`${appraisal.address}, ${appraisal.city}${appraisal.locationCount > 1 ? ` — ${appraisal.locationCount} reports at this location` : ''}`}
                label={appraisal.locationCount > 1 && appraisal.locationIndex === 0 ? {
                  text: String(appraisal.locationCount),
                  color: '#ffffff',
                  fontSize: '10px',
                  fontWeight: '700',
                } : undefined}
                onClick={() => onMarkerClick(appraisal)}
                onMouseOver={() => onMarkerHover(appraisal.id)}
                onMouseOut={() => onMarkerHover(null)}
              />
            );
          })}
        </>
      )}
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

function safeDocumentName(report, extension) {
  const base = `${report.address || 'appraisal'}-${report.city || 'report'}`
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'appraisal-report';
  return `${base}.${extension}`;
}

function showPendingDocument(windowReference, label) {
  if (!windowReference?.document) return;
  const document = windowReference.document;
  document.title = `Preparing ${label}`;
  document.body.replaceChildren();
  document.body.style.cssText = 'margin:0;min-height:100vh;display:grid;place-items:center;background:#f0f3ee;color:#172529;font:16px/1.5 system-ui,sans-serif';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = `Preparing your protected ${label.toLowerCase()}…`;
  document.body.appendChild(status);
}

function MapView({ session, showToast = () => {} }) {
  const [appraisals, setAppraisals] = useState([]);
  const [loadingReports, setLoadingReports] = useState(false);
  const [reportsError, setReportsError] = useState('');
  const [lastSuccessfulAt, setLastSuccessfulAt] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [metadataSupported, setMetadataSupported] = useState(null);
  const [selectedAppraisal, setSelectedAppraisal] = useState(null);
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
  const [manualPlacement, setManualPlacement] = useState({ active: false, location: null });
  const [signingOut, setSigningOut] = useState(false);
  const [googleAuthFailed, setGoogleAuthFailed] = useState(false);

  const mapRef = useRef(null);
  const mapIdleTimerRef = useRef(null);
  const autocompleteTimerRef = useRef(null);
  const autocompleteRequestRef = useRef(0);
  const autocompleteSessionTokenRef = useRef(null);
  const reportRequestRef = useRef(null);
  const lastBoundsRef = useRef(null);
  const lastSuccessfulBoundsKeyRef = useRef(null);
  const lastSuccessfulQueryBoundsRef = useRef(null);
  const signedUrlCacheRef = useRef(new Map());
  const placeDetailsRequestRef = useRef(0);
  const workspacePanelRef = useRef(null);
  const panelReturnFocusRef = useRef(null);
  const previousPanelOpenRef = useRef(true);
  const previousPanelModeRef = useRef('nearby');
  const discardReturnFocusRef = useRef(null);

  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: process.env.REACT_APP_GOOGLE_MAPS_API_KEY,
    libraries: GOOGLE_MAP_LIBRARIES,
  });

  const access = useMemo(() => getAppraisalAccess(session), [session]);
  const canMutate = access.canMutate;
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

  const fetchReports = useCallback(async (bounds, { force = false } = {}) => {
    if (!bounds) return;
    if (!force && boundsContain(lastSuccessfulQueryBoundsRef.current, bounds)) return;
    const queryBounds = padBounds(bounds);
    const key = boundsKey(queryBounds);
    if (!force && lastSuccessfulBoundsKeyRef.current === key) return;

    if (reportRequestRef.current) reportRequestRef.current.abort();
    const controller = new AbortController();
    reportRequestRef.current = controller;
    setLoadingReports(true);
    setReportsError('');

    try {
      const result = await fetchAppraisalsInBounds(supabase, queryBounds, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const nextAppraisals = applySpiralOffset(result.data);
      setAppraisals(nextAppraisals);
      setTruncated(result.truncated);
      setMetadataSupported(result.metadataSupported);
      setCandidates((current) => current.map((candidate) => (
        nextAppraisals.find((report) => report.id === candidate.id) || candidate
      )));
      setSelectedAppraisal((current) => (
        current ? nextAppraisals.find((report) => report.id === current.id) || current : null
      ));
      lastSuccessfulBoundsKeyRef.current = key;
      lastSuccessfulQueryBoundsRef.current = queryBounds;
      setLastSuccessfulAt(new Date());
      recordTelemetryEvent('map_reports_load', {
        outcome: 'success',
        online: navigator.onLine,
        resultBucket: result.data.length >= 100 ? '100_plus' : result.data.length >= 20 ? '20_99' : '0_19',
      });
    } catch (error) {
      if (!isAbortError(error)) {
        console.error('Could not load appraisals in map bounds', error);
        setReportsError('Check your connection and retry this map area.');
        recordTelemetryEvent('map_reports_load', {
          outcome: 'failed',
          errorCode: error?.code || 'unknown',
          online: navigator.onLine,
        });
      }
    } finally {
      if (reportRequestRef.current === controller) {
        reportRequestRef.current = null;
        setLoadingReports(false);
      }
    }
  }, []);

  const refreshCurrentBounds = useCallback(() => {
    const bounds = lastBoundsRef.current || boundsFromMap(mapRef.current);
    if (!bounds) return;
    lastSuccessfulBoundsKeyRef.current = null;
    lastSuccessfulQueryBoundsRef.current = null;
    fetchReports(bounds, { force: true });
  }, [fetchReports]);

  const handleMapIdle = useCallback(() => {
    if (mapIdleTimerRef.current) window.clearTimeout(mapIdleTimerRef.current);
    mapIdleTimerRef.current = window.setTimeout(() => {
      const bounds = boundsFromMap(mapRef.current);
      if (!bounds) return;
      lastBoundsRef.current = bounds;
      fetchReports(bounds);
    }, MAP_IDLE_DEBOUNCE_MS);
  }, [fetchReports]);

  useEffect(() => () => {
    if (mapIdleTimerRef.current) window.clearTimeout(mapIdleTimerRef.current);
    if (autocompleteTimerRef.current) window.clearTimeout(autocompleteTimerRef.current);
    if (reportRequestRef.current) reportRequestRef.current.abort();
  }, []);

  useEffect(() => {
    const handleGoogleAuthFailure = () => {
      setGoogleAuthFailed(true);
      recordTelemetryEvent('address_lookup', {
        outcome: 'failed',
        errorCode: 'REQUEST_DENIED',
        source: 'google',
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
    if (!panelOpen || previousMode === panelMode) return undefined;
    const frame = window.requestAnimationFrame(focusPanelHeading);
    return () => window.cancelAnimationFrame(frame);
  }, [focusPanelHeading, panelMode, panelOpen]);

  const preparedReports = useMemo(() => appraisals.map((report) => ({
    ...report,
    _distanceKm: subject ? getReportDistanceKm(report, subject) : null,
    _formattedEffectiveDate: formatDateOnly(report.effective_date),
    _formattedReportDate: formatDateOnly(report.appraisal_date),
  })), [appraisals, subject]);

  const effectiveSort = !subject && filters.sortBy === 'distance' ? 'newest' : filters.sortBy;
  const filteredReports = useMemo(() => filterAndSortReports(
    preparedReports,
    { ...filters, sortBy: effectiveSort },
    subject
  ), [effectiveSort, filters, preparedReports, subject]);
  const missingFilterCounts = useMemo(
    () => countReportsMissingFilterData(preparedReports),
    [preparedReports]
  );
  const activeFilterCount = [filters.radiusKm, filters.propertyType, filters.dateFrom, filters.dateTo]
    .filter(Boolean).length;

  const getSignedUrl = useCallback(async (bucket, path, downloadName = null) => {
    if (!path) return null;
    const key = `${bucket}/${path}`;
    const cached = signedUrlCacheRef.current.get(key);
    if (cached && cached.expiresAt - SIGNED_URL_REFRESH_BUFFER_MS > Date.now()) return cached.url;

    const { data, error } = await withTimeout(
      supabase.storage
        .from(bucket)
        .createSignedUrl(
          path,
          SIGNED_URL_TTL_SECONDS,
          downloadName ? { download: downloadName } : undefined
        ),
      REMOTE_OPERATION_TIMEOUT_MS,
      'The protected report link took too long to prepare.'
    );
    if (error || !data?.signedUrl) {
      console.error(`Could not create a protected link for ${bucket}`, error);
      return null;
    }
    signedUrlCacheRef.current.set(key, {
      url: data.signedUrl,
      expiresAt: Date.now() + SIGNED_URL_TTL_SECONDS * 1000,
    });
    return data.signedUrl;
  }, []);

  const handleOpenReport = useCallback(async (report, explicitFolderPath = null) => {
    const pdfPath = explicitFolderPath ? null : report.pdf_url;
    const folderPath = explicitFolderPath || report.folder_files?.[0];
    const bucket = pdfPath ? 'pdfs' : folderPath ? 'appraisal-folders' : null;
    const path = pdfPath || folderPath;
    const isFolder = Boolean(folderPath);
    const documentLabel = isFolder ? 'document folder' : 'PDF';
    const downloadName = isFolder
      ? safeDocumentName(report, 'zip')
      : safeDocumentName(report, 'pdf');
    if (!bucket || !path) {
      showToast({ tone: 'info', message: 'No report document is attached to this record.' });
      return;
    }

    const pendingWindow = window.open('about:blank', '_blank');
    if (pendingWindow) {
      pendingWindow.opener = null;
      showPendingDocument(pendingWindow, documentLabel);
    }
    setOpeningReportId(report.id);
    try {
      const url = await getSignedUrl(bucket, path, downloadName);
      if (!url) throw new Error('The protected report link was not returned.');
      if (pendingWindow) {
        pendingWindow.location.replace(url);
      } else {
        showToast({
          tone: 'info',
          title: `${documentLabel === 'PDF' ? 'PDF' : 'Folder'} ready`,
          message: 'Your browser blocked the new tab. Use the button below to continue.',
          persistent: true,
          action: { label: isFolder ? 'Download folder' : 'Open PDF', href: url },
        });
      }
      recordTelemetryEvent('document_open', {
        outcome: 'success',
        documentType: isFolder ? 'folder' : 'pdf',
      });
    } catch (error) {
      pendingWindow?.close();
      const referenceId = createSupportReference('document');
      showToast({
        tone: 'error',
        title: 'Report not opened',
        message: error?.message || 'The report link could not be prepared. Try again.',
        persistent: true,
        referenceId,
      });
      recordTelemetryEvent('document_open', {
        outcome: 'failed',
        errorCode: error?.code || 'unknown',
        documentType: isFolder ? 'folder' : 'pdf',
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
        if (error?.code !== GEOCODING_ERROR_CODES.ZERO_RESULTS) {
          setSearchError(error?.message || 'Address suggestions are temporarily unavailable.');
        }
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
        propertyType: '',
        reportedLivingAreaSqFt: '',
        yearBuilt: '',
      };
      runWorkspaceAction(() => {
      setSubject(nextSubject);
        setCandidates([]);
        setSearchTerm(nextSubject.address);
        setFilters((current) => ({ ...current, radiusKm: '', sortBy: 'distance' }));
        setPanelMode('nearby');
        setPanelOpen(true);
        fitMapToSubjectRadius(nextSubject, 10);
      });
      recordTelemetryEvent('address_lookup', { outcome: 'success', source: 'google' });
    } catch (error) {
      if (requestId !== placeDetailsRequestRef.current) return;
      autocompleteSessionTokenRef.current = null;
      setSearchBusy(false);
      setSearchError(error?.message || 'That location could not be set. Choose another suggested address.');
      recordTelemetryEvent('address_lookup', {
        outcome: 'failed',
        errorCode: error?.code || 'unknown',
        source: 'google',
      });
    }
  }, [fitMapToSubjectRadius, resolveSuggestion, runWorkspaceAction]);

  const handleSearchSubmit = useCallback(async () => {
    if (!searchTerm.trim() || searchBusy || !window.google?.maps?.places) return;
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
      setSearchError(error?.message || 'Address search is temporarily unavailable. Try again.');
      recordTelemetryEvent('address_lookup', {
        outcome: 'failed',
        errorCode: error?.code || 'unknown',
        source: 'google',
      });
    }
  }, [getPredictions, searchBusy, searchTerm]);

  const clearSubject = useCallback(() => {
    runWorkspaceAction(() => {
      autocompleteRequestRef.current += 1;
      autocompleteSessionTokenRef.current = null;
      placeDetailsRequestRef.current += 1;
      setSubject(null);
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
    setFilters((current) => ({ ...current, [field]: value }));
    if (field === 'radiusKm' && value && subject) {
      fitMapToSubjectRadius(subject, value);
    }
  }, [fitMapToSubjectRadius, subject]);

  const handleResetFilters = useCallback(() => {
    setFilters({ ...DEFAULT_FILTERS, sortBy: subject ? 'distance' : 'newest' });
  }, [subject]);

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
      setPanelMode('detail');
      setPanelOpen(true);
      focusReportOnMap(report);
    });
  }, [focusReportOnMap, runWorkspaceAction]);

  const handleMarkerClick = useCallback((report) => {
    handleOpenDetails(report);
  }, [handleOpenDetails]);

  const handleAdded = useCallback((result = {}) => {
    setWorkspaceState(EMPTY_WORKSPACE_STATE);
    setManualPlacement({ active: false, location: null });
    const created = result.report || (Array.isArray(result.data) ? result.data[0] : result.data);
    if (created?.id) {
      setAppraisals((current) => applySpiralOffset([
        created,
        ...current.filter((report) => String(report.id) !== String(created.id)),
      ]));
      setSelectedAppraisal(created);
      setPanelMode('detail');
      setPanelOpen(true);
      lastSuccessfulBoundsKeyRef.current = null;
      lastSuccessfulQueryBoundsRef.current = null;
      focusReportOnMap(created);
    } else {
      setPanelMode('nearby');
      refreshCurrentBounds();
    }
    showToast({ tone: result.tone || 'success', message: result.message || 'Appraisal saved.' });
    recordTelemetryEvent('appraisal_mutation', { outcome: 'success', operation: 'create' });
  }, [focusReportOnMap, refreshCurrentBounds, showToast]);

  const handleUpdated = useCallback((result = 'Report updated', updatedAppraisal = null) => {
    setWorkspaceState(EMPTY_WORKSPACE_STATE);
    const updated = updatedAppraisal || (typeof result === 'object'
      ? result.report || result.data || (result.id ? result : null)
      : null);
    if (updated?.id) {
      setAppraisals((current) => current.map((report) => (
        String(report.id) === String(updated.id) ? { ...report, ...updated } : report
      )));
      setSelectedAppraisal((current) => current ? { ...current, ...updated } : updated);
    }
    setPanelMode('detail');
    refreshCurrentBounds();
    showToast({
      tone: 'success',
      message: typeof result === 'string' ? result : result.message || 'Report updated.',
    });
    recordTelemetryEvent('appraisal_mutation', { outcome: 'success', operation: 'update' });
  }, [refreshCurrentBounds, showToast]);

  const handleDeleted = useCallback((message = 'Report removed') => {
    setWorkspaceState(EMPTY_WORKSPACE_STATE);
    if (selectedAppraisal) {
      setCandidates((current) => current.filter((candidate) => candidate.id !== selectedAppraisal.id));
    }
    setSelectedAppraisal(null);
    setPanelMode('nearby');
    refreshCurrentBounds();
    showToast({ tone: 'success', message });
    recordTelemetryEvent('appraisal_mutation', { outcome: 'success', operation: 'archive' });
  }, [refreshCurrentBounds, selectedAppraisal, showToast]);

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
      recordTelemetryEvent('auth_sign_out', { outcome: 'success', online: navigator.onLine });
    } catch (error) {
      const referenceId = createSupportReference('signout');
      showToast({
        tone: 'error',
        title: 'Still signed in',
        message: error?.message || 'Sign out failed. Check your connection and try again.',
        persistent: true,
        referenceId,
      });
      recordTelemetryEvent('auth_sign_out', {
        outcome: 'failed',
        errorCode: error?.code || 'unknown',
        online: navigator.onLine,
      });
    } finally {
      setSigningOut(false);
    }
  }, [showToast, signingOut]);

  const handleSignOut = useCallback(() => {
    runWorkspaceAction(performSignOut);
  }, [performSignOut, runWorkspaceAction]);

  const handleRemoveCandidate = useCallback((id) => {
    setCandidates((current) => current.filter((candidate) => candidate.id !== id));
    if (candidates.length <= 1) setPanelMode('nearby');
  }, [candidates.length]);

  const beginManualPlacement = useCallback(() => {
    setManualPlacement({ active: true, location: null });
    showToast({
      tone: 'info',
      title: 'Place the property pin',
      message: 'Click the exact property location on the map. You can drag the pin to adjust it.',
      persistent: true,
    });
  }, [showToast]);

  const cancelManualPlacement = useCallback(() => {
    setManualPlacement({ active: false, location: null });
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

  if (loadError || googleAuthFailed) {
    return (
      <main className="map-fatal" role="alert">
        <BrandLogo className="map-fatal__logo" />
        <h1>The map could not be loaded</h1>
        <p>
          {googleAuthFailed
            ? 'The Google Maps key was rejected. An administrator needs to check its API and website restrictions.'
            : 'Check the connection and mapping configuration, then reload the page.'}
        </p>
        <button type="button" className="button button--primary" onClick={() => window.location.reload()}>Reload</button>
      </main>
    );
  }

  return (
    <main className="map-app">
      <header className="map-header">
        <div className="map-brand" aria-label="Appraisal Map">
          <BrandLogo className="map-brand__logo" />
          <strong>Appraisal Map</strong>
        </div>
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
        <nav className="map-header__actions" aria-label="Workspace actions">
          {!canMutate && (
            <span className="map-access-badge" title={access.reason || undefined}>View only</span>
          )}
          <button type="button" className="button button--secondary" onClick={() => {
            runWorkspaceAction(() => {
              setPanelOpen((open) => !open);
              if (!panelOpen) setPanelMode('nearby');
            });
          }}>
            <MapIcon /> {panelOpen ? 'Hide panel' : 'Show reports'}
          </button>
          {canMutate && (
            <button type="button" className="button button--primary" onClick={() => {
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
      </header>

      <div className="map-stage">
        {!isLoaded ? (
          <div className="map-loading" role="status">
            <span aria-hidden="true" />
            Loading map and reports…
          </div>
        ) : (
          <GoogleMap
            mapContainerStyle={MAP_CONTAINER_STYLE}
            onLoad={(map) => { mapRef.current = map; }}
            onUnmount={() => { mapRef.current = null; }}
            onIdle={handleMapIdle}
            onClick={handleMapClick}
            options={mapOptions}
          >
            <MarkerLayer
              appraisals={appraisals}
              selectedId={selectedAppraisal?.id || null}
              candidateIds={candidateIds}
              hoveredId={hoveredReportId}
              onMarkerClick={manualPlacement.active ? () => {} : handleMarkerClick}
              onMarkerHover={setHoveredReportId}
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
                draggable
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

        {manualPlacement.active && (
          <div className="manual-placement-guide" role="status">
            <div>
              <strong>{manualPlacement.location ? 'Pin selected' : 'Choose the property location'}</strong>
              <span>
                {manualPlacement.location
                  ? 'Drag the pin if needed, then save from the form.'
                  : 'Click the exact property on the map.'}
              </span>
            </div>
            <button type="button" onClick={cancelManualPlacement}>
              {manualPlacement.location ? 'Use this pin' : 'Cancel'}
            </button>
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
            className={`workspace-panel workspace-panel--${panelMode}${manualPlacement.active ? ' workspace-panel--placing' : ''}`}
            aria-label="Appraisal workspace panel"
            tabIndex="-1"
          >
            <button
              type="button"
              className="workspace-panel__close icon-button"
              onClick={() => {
                runWorkspaceAction(() => setPanelOpen(false));
              }}
              aria-label="Close workspace panel"
            >
              ×
            </button>
            {panelMode === 'add' ? (
              <Suspense fallback={<div className="panel-loader" role="status">Loading form…</div>}>
                <AddAppraisal
                  onAdded={handleAdded}
                  metadataSupported={metadataSupported}
                  onWorkspaceStateChange={handleWorkspaceStateChange}
                  manualPlacement={manualPlacement}
                  onRequestManualPlacement={beginManualPlacement}
                  onCancelManualPlacement={cancelManualPlacement}
                />
              </Suspense>
            ) : panelMode === 'detail' && selectedAppraisal ? (
              <AppraisalDetailPanel
                key={selectedAppraisal.id}
                appraisal={selectedAppraisal}
                getSignedUrl={getSignedUrl}
                onBack={() => runWorkspaceAction(() => {
                  setSelectedAppraisal(null);
                  setPanelMode('nearby');
                })}
                onUpdated={handleUpdated}
                onDeleted={handleDeleted}
                onOpenReport={handleOpenReport}
                openingReportId={openingReportId}
                metadataSupported={metadataSupported}
                canMutate={canMutate}
                onWorkspaceStateChange={handleWorkspaceStateChange}
              />
            ) : (
              <NearbyWorkspace
                subject={subject}
                onSubjectFactChange={handleSubjectFactChange}
                reports={filteredReports}
                unfilteredCount={preparedReports.length}
                loading={loadingReports}
                error={reportsError}
                lastUpdatedAt={lastSuccessfulAt}
                truncated={truncated}
                metadataSupported={metadataSupported}
                filters={filters}
                activeFilterCount={activeFilterCount}
                missingFilterCounts={missingFilterCounts}
                onFilterChange={handleFilterChange}
                onResetFilters={handleResetFilters}
                candidateIds={candidateIds}
                candidates={candidates.map((candidate) => ({
                  ...candidate,
                  _distanceKm: subject ? getReportDistanceKm(candidate, subject) : null,
                  _formattedEffectiveDate: formatDateOnly(candidate.effective_date),
                  _formattedReportDate: formatDateOnly(candidate.appraisal_date),
                }))}
                onToggleCandidate={handleToggleCandidate}
                onOpenDetails={handleOpenDetails}
                onOpenReport={handleOpenReport}
                openingReportId={openingReportId}
                onHoverReport={setHoveredReportId}
                view={panelMode}
                onCompare={() => {
                  if (!subject) showToast('Set a subject property before comparing reports.');
                  else setPanelMode('compare');
                }}
                onBackFromCompare={() => setPanelMode('nearby')}
                onRemoveCandidate={handleRemoveCandidate}
                onRetry={refreshCurrentBounds}
              />
            )}
          </aside>
        )}

        {discardAction && (
          <div className="calm-dialog-backdrop" role="presentation">
            <section
              className="calm-dialog"
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
