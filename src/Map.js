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
import {
  SUPPORTED_MAP_BOUNDS,
  isWithinSupportedMapBounds,
} from './domain/geocoding';
import {
  countReportsMissingFilterData,
  filterAndSortReports,
  getReportDistanceKm,
} from './domain/filters';
import { fetchAppraisalsInBounds } from './services/appraisalService';
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
const APP_BOUNDS = SUPPORTED_MAP_BOUNDS;
const DEFAULT_FILTERS = {
  radiusKm: '',
  propertyType: '',
  dateFrom: '',
  dateTo: '',
  sortBy: 'newest',
};
const EMPTY_WORKSPACE_STATE = { dirty: false, busy: false };

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

function isAbortError(error) {
  return error?.name === 'AbortError' || /abort/i.test(error?.message || '');
}

function getCanMutate(session) {
  // UI gating is advisory; Supabase RLS remains the authority. Only server-controlled
  // app_metadata is trusted here because user_metadata can be edited by the user.
  const role = session?.user?.app_metadata?.role;
  if (!role) return true;
  return !['viewer', 'read_only', 'readonly'].includes(String(role).toLowerCase());
}

function MapView({ session, showToast = () => {} }) {
  const [appraisals, setAppraisals] = useState([]);
  const [loadingReports, setLoadingReports] = useState(false);
  const [reportsError, setReportsError] = useState('');
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

  const mapRef = useRef(null);
  const mapIdleTimerRef = useRef(null);
  const autocompleteTimerRef = useRef(null);
  const autocompleteRequestRef = useRef(0);
  const autocompleteSessionTokenRef = useRef(null);
  const placesApiModeRef = useRef('unknown');
  const reportRequestRef = useRef(null);
  const lastBoundsRef = useRef(null);
  const lastSuccessfulBoundsKeyRef = useRef(null);
  const signedUrlCacheRef = useRef(new Map());
  const placeDetailsRequestRef = useRef(0);
  const workspacePanelRef = useRef(null);
  const panelReturnFocusRef = useRef(null);
  const previousPanelOpenRef = useRef(true);
  const previousPanelModeRef = useRef('nearby');

  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: process.env.REACT_APP_GOOGLE_MAPS_API_KEY,
    libraries: GOOGLE_MAP_LIBRARIES,
  });

  const canMutate = useMemo(() => getCanMutate(session), [session]);
  const candidateIds = useMemo(() => candidates.map((candidate) => candidate.id), [candidates]);

  const handleWorkspaceStateChange = useCallback((nextState = EMPTY_WORKSPACE_STATE) => {
    const next = {
      dirty: Boolean(nextState.dirty),
      busy: Boolean(nextState.busy),
    };
    setWorkspaceState((current) => (
      current.dirty === next.dirty && current.busy === next.busy ? current : next
    ));
  }, []);

  const canLeaveWorkspace = useCallback(() => {
    if (workspaceState.busy) {
      showToast('Please wait for the current save to finish.');
      return false;
    }
    if (workspaceState.dirty && !window.confirm('Discard your unsaved changes?')) {
      return false;
    }
    setWorkspaceState(EMPTY_WORKSPACE_STATE);
    return true;
  }, [showToast, workspaceState]);

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
    restriction: { latLngBounds: APP_BOUNDS, strictBounds: false },
    gestureHandling: 'cooperative',
    minZoom: 8,
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
    const key = boundsKey(bounds);
    if (!force && lastSuccessfulBoundsKeyRef.current === key) return;

    if (reportRequestRef.current) reportRequestRef.current.abort();
    const controller = new AbortController();
    reportRequestRef.current = controller;
    setLoadingReports(true);
    setReportsError('');

    try {
      const result = await fetchAppraisalsInBounds(supabase, bounds, { signal: controller.signal });
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
    } catch (error) {
      if (!isAbortError(error)) {
        console.error('Could not load appraisals in map bounds', error);
        setReportsError('Check your connection and retry this map area.');
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
      const frame = window.requestAnimationFrame(() => {
        workspacePanelRef.current?.focus({ preventScroll: true });
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (!panelOpen && wasOpen) {
      panelReturnFocusRef.current?.focus?.({ preventScroll: true });
    }
    return undefined;
  }, [panelOpen]);

  useEffect(() => {
    const previousMode = previousPanelModeRef.current;
    previousPanelModeRef.current = panelMode;
    if (!panelOpen || previousMode === panelMode) return undefined;
    const frame = window.requestAnimationFrame(() => {
      workspacePanelRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [panelMode, panelOpen]);

  useEffect(() => {
    if (!panelOpen) return undefined;
    const handleEscape = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (canLeaveWorkspace()) {
        event.preventDefault();
        setPanelOpen(false);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [canLeaveWorkspace, panelOpen]);

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

  const getSignedUrl = useCallback(async (bucket, path) => {
    if (!path) return null;
    const key = `${bucket}/${path}`;
    const cached = signedUrlCacheRef.current.get(key);
    if (cached && cached.expiresAt - SIGNED_URL_REFRESH_BUFFER_MS > Date.now()) return cached.url;

    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
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
    if (!bucket || !path) {
      showToast('No report document is attached to this record.');
      return;
    }

    const pendingWindow = window.open('about:blank', '_blank');
    if (!pendingWindow) {
      showToast('Your browser blocked the report window. Allow pop-ups for this app and try again.');
      return;
    }
    pendingWindow.opener = null;
    pendingWindow.document.title = 'Opening protected report…';
    setOpeningReportId(report.id);
    const url = await getSignedUrl(bucket, path);
    setOpeningReportId(null);
    if (!url) {
      pendingWindow.close();
      showToast('The report link could not be prepared. Try again.');
      return;
    }
    pendingWindow.location.replace(url);
  }, [getSignedUrl, showToast]);

  const getPredictions = useCallback(async (value) => {
    const places = window.google?.maps?.places;
    if (!places) return [];

    if (placesApiModeRef.current !== 'legacy' && places.AutocompleteSuggestion) {
      try {
        if (!autocompleteSessionTokenRef.current && places.AutocompleteSessionToken) {
          autocompleteSessionTokenRef.current = new places.AutocompleteSessionToken();
        }
        const response = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: value,
          includedRegionCodes: ['ca'],
          language: 'en-CA',
          region: 'ca',
          locationRestriction: APP_BOUNDS,
          sessionToken: autocompleteSessionTokenRef.current || undefined,
        });
        placesApiModeRef.current = 'new';
        return (response.suggestions || [])
          .map((item) => item.placePrediction)
          .filter(Boolean)
          .map((placePrediction) => ({
            place_id: placePrediction.placeId,
            description: String(placePrediction.text || ''),
            placePrediction,
          }))
          .filter((prediction) => prediction.place_id && prediction.description);
      } catch {
        placesApiModeRef.current = 'legacy';
        autocompleteSessionTokenRef.current = null;
      }
    }

    return new Promise((resolve) => {
      const service = new places.AutocompleteService();
      service.getPlacePredictions({
        input: value,
        componentRestrictions: { country: 'ca' },
        locationRestriction: APP_BOUNDS,
      }, (predictions, status) => {
        resolve(status === places.PlacesServiceStatus.OK && predictions ? predictions : []);
      });
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
      const predictions = await getPredictions(value);
      if (requestId !== autocompleteRequestRef.current) return;
      setSuggestions(predictions.slice(0, 5));
    }, AUTOCOMPLETE_DEBOUNCE_MS);
  }, [getPredictions]);

  const resolveSuggestion = useCallback(async (suggestion) => {
    if (suggestion.placePrediction?.toPlace) {
      const place = suggestion.placePrediction.toPlace();
      await place.fetchFields({ fields: ['formattedAddress', 'location'] });
      if (!place.location) throw new Error('Place details did not include a mapped location.');
      return {
        latitude: place.location.lat(),
        longitude: place.location.lng(),
        formattedAddress: place.formattedAddress || suggestion.description,
      };
    }

    return new Promise((resolve, reject) => {
      const places = window.google.maps.places;
      const service = new places.PlacesService(mapRef.current || document.createElement('div'));
      service.getDetails({
        placeId: suggestion.place_id,
        fields: ['geometry', 'formatted_address'],
      }, (place, status) => {
        if (status !== places.PlacesServiceStatus.OK || !place?.geometry?.location) {
          reject(new Error('Place details were unavailable.'));
          return;
        }
        resolve({
          latitude: place.geometry.location.lat(),
          longitude: place.geometry.location.lng(),
          formattedAddress: place.formatted_address || suggestion.description,
        });
      });
    });
  }, []);

  const setSubjectFromSuggestion = useCallback(async (suggestion) => {
    autocompleteRequestRef.current += 1;
    autocompleteSessionTokenRef.current = null;
    setSearchBusy(true);
    setSearchError('');
    setSuggestions([]);
    setActiveSuggestionIndex(-1);
    const requestId = ++placeDetailsRequestRef.current;
    try {
      const place = await resolveSuggestion(suggestion);
      if (requestId !== placeDetailsRequestRef.current) return;
      setSearchBusy(false);
      const { latitude, longitude } = place;
      if (!isWithinSupportedMapBounds(latitude, longitude)) {
        setSearchError('Choose a subject in the Southern Ontario map area.');
        return;
      }
      if (!canLeaveWorkspace()) return;
      const nextSubject = {
        latitude,
        longitude,
        address: place.formattedAddress || suggestion.description,
        propertyType: '',
        reportedLivingAreaSqFt: '',
        yearBuilt: '',
      };
      setSubject(nextSubject);
      setCandidates([]);
      setSearchTerm(nextSubject.address);
      setFilters((current) => ({ ...current, radiusKm: '', sortBy: 'distance' }));
      setPanelMode('nearby');
      setPanelOpen(true);
      fitMapToSubjectRadius(nextSubject, 10);
    } catch {
      if (requestId !== placeDetailsRequestRef.current) return;
      setSearchBusy(false);
      setSearchError('That location could not be set. Choose another suggested address.');
    }
  }, [canLeaveWorkspace, fitMapToSubjectRadius, resolveSuggestion]);

  const handleSearchSubmit = useCallback(async () => {
    if (!searchTerm.trim() || searchBusy || !window.google?.maps?.places) return;
    const requestId = ++autocompleteRequestRef.current;
    setSearchBusy(true);
    setSearchError('');
    const predictions = await getPredictions(searchTerm.trim());
    if (requestId !== autocompleteRequestRef.current) return;
    setSearchBusy(false);
    if (predictions.length === 0) {
      setSuggestions([]);
      setSearchError('No matching Canadian location was found. Check the address and try again.');
      return;
    }
    setSubjectFromSuggestion(predictions[0]);
  }, [getPredictions, searchBusy, searchTerm, setSubjectFromSuggestion]);

  const clearSubject = useCallback(() => {
    if (!canLeaveWorkspace()) return;
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
  }, [canLeaveWorkspace]);

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
      showToast('Set a subject property before selecting candidates.');
      return;
    }
    setCandidates((current) => {
      if (current.some((candidate) => candidate.id === report.id)) {
        return current.filter((candidate) => candidate.id !== report.id);
      }
      if (current.length >= 3) {
        showToast('You can compare up to three candidates at a time.');
        return current;
      }
      return [...current, report];
    });
  }, [showToast, subject]);

  const handleOpenDetails = useCallback((report) => {
    if (!canLeaveWorkspace()) return;
    setSelectedAppraisal(report);
    setPanelMode('detail');
    setPanelOpen(true);
    mapRef.current?.panTo({ lat: report.latitude, lng: report.longitude });
  }, [canLeaveWorkspace]);

  const handleMarkerClick = useCallback((report) => {
    handleOpenDetails(report);
  }, [handleOpenDetails]);

  const handleAdded = useCallback((result = {}) => {
    setWorkspaceState(EMPTY_WORKSPACE_STATE);
    setPanelMode('nearby');
    refreshCurrentBounds();
    showToast(result.message || 'Appraisal saved.');
  }, [refreshCurrentBounds, showToast]);

  const handleUpdated = useCallback((message = 'Report updated') => {
    setWorkspaceState(EMPTY_WORKSPACE_STATE);
    setSelectedAppraisal(null);
    setPanelMode('nearby');
    refreshCurrentBounds();
    showToast(message);
  }, [refreshCurrentBounds, showToast]);

  const handleDeleted = useCallback((message = 'Report removed') => {
    setWorkspaceState(EMPTY_WORKSPACE_STATE);
    if (selectedAppraisal) {
      setCandidates((current) => current.filter((candidate) => candidate.id !== selectedAppraisal.id));
    }
    setSelectedAppraisal(null);
    setPanelMode('nearby');
    refreshCurrentBounds();
    showToast(message);
  }, [refreshCurrentBounds, selectedAppraisal, showToast]);

  const handleSignOut = useCallback(async () => {
    if (!canLeaveWorkspace()) return;
    const { error } = await supabase.auth.signOut();
    if (error) showToast('Sign out failed. Try again.');
  }, [canLeaveWorkspace, showToast]);

  const handleRemoveCandidate = useCallback((id) => {
    setCandidates((current) => current.filter((candidate) => candidate.id !== id));
    if (candidates.length <= 1) setPanelMode('nearby');
  }, [candidates.length]);

  if (loadError) {
    return (
      <main className="map-fatal" role="alert">
        <BrandLogo className="map-fatal__logo" />
        <h1>The map could not be loaded</h1>
        <p>Check the connection and mapping configuration, then reload the page.</p>
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
        />
        <nav className="map-header__actions" aria-label="Workspace actions">
          <button type="button" className="button button--secondary" onClick={() => {
            if (panelOpen && !canLeaveWorkspace()) return;
            setPanelOpen((open) => !open);
            if (!panelOpen) setPanelMode('nearby');
          }}>
            <MapIcon /> {panelOpen ? 'Hide panel' : 'Show reports'}
          </button>
          {canMutate && (
            <button type="button" className="button button--primary" onClick={() => {
              if (panelMode !== 'add' && !canLeaveWorkspace()) return;
              setPanelMode('add');
              setPanelOpen(true);
            }}>
              <span aria-hidden="true">＋</span> Add appraisal
            </button>
          )}
          <button type="button" className="button button--quiet map-header__logout" onClick={handleSignOut}>Sign out</button>
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
            onClick={() => {
              if (panelMode === 'detail' && canLeaveWorkspace()) {
                setSelectedAppraisal(null);
                setPanelMode('nearby');
              }
            }}
            options={mapOptions}
          >
            <MarkerLayer
              appraisals={appraisals}
              selectedId={selectedAppraisal?.id || null}
              candidateIds={candidateIds}
              hoveredId={hoveredReportId}
              onMarkerClick={handleMarkerClick}
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
          </GoogleMap>
        )}

        {!panelOpen && (
          <button type="button" className="map-panel-reopen" onClick={() => setPanelOpen(true)}>
            <MapIcon /> Show {filteredReports.length} reports
          </button>
        )}

        {panelOpen && (
          <aside
            ref={workspacePanelRef}
            className={`workspace-panel workspace-panel--${panelMode}`}
            aria-label="Appraisal workspace panel"
            tabIndex="-1"
          >
            <button
              type="button"
              className="workspace-panel__close icon-button"
              onClick={() => {
                if (canLeaveWorkspace()) setPanelOpen(false);
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
                />
              </Suspense>
            ) : panelMode === 'detail' && selectedAppraisal ? (
              <AppraisalDetailPanel
                key={selectedAppraisal.id}
                appraisal={selectedAppraisal}
                getSignedUrl={getSignedUrl}
                onBack={() => { setSelectedAppraisal(null); setPanelMode('nearby'); }}
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
      </div>
    </main>
  );
}

export default MapView;
