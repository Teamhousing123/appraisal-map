import React, { useEffect, useId, useRef, useState } from 'react';
import {
  GEOCODING_ERROR_CODES,
  addressFingerprint,
  formatCanonicalStreetAddress,
  getAddressPredictions,
  resolveAddressSuggestion,
  toNormalizedAddressColumns,
  validateResolvedOntarioCivicAddress,
} from '../domain/geocoding';
import { SUPPORTED_MAP_BOUNDS } from '../domain/serviceArea';

const LOOKUP_DELAY_MS = 280;

function AddressPicker({
  idPrefix,
  address,
  city,
  onAddressChange,
  onCityChange,
  onResolved,
  disabled = false,
  errors = {},
  addressLabel = 'Street address',
  cityLabel = 'City',
}) {
  const generatedId = useId();
  const prefix = idPrefix || `address-${generatedId}`;
  const listboxId = `${prefix}-suggestions`;
  const [suggestions, setSuggestions] = useState([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const requestRef = useRef(0);
  const timerRef = useRef(null);
  const sessionTokenRef = useRef(null);
  const suppressedLookupRef = useRef('');

  useEffect(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    const street = address.trim();
    const locality = city.trim();
    const currentFingerprint = addressFingerprint(street, locality);
    if (suppressedLookupRef.current === currentFingerprint) {
      setSuggestions([]);
      setActiveIndex(-1);
      setBusy(false);
      return undefined;
    }
    if (disabled || street.length < 3 || !window.google?.maps?.places) {
      setSuggestions([]);
      setActiveIndex(-1);
      setBusy(false);
      return undefined;
    }

    const requestId = ++requestRef.current;
    setBusy(true);
    setLookupError('');
    timerRef.current = window.setTimeout(async () => {
      try {
        const places = window.google.maps.places;
        if (!sessionTokenRef.current && places.AutocompleteSessionToken) {
          sessionTokenRef.current = new places.AutocompleteSessionToken();
        }
        const query = [street, locality].filter(Boolean).join(', ');
        const matches = await getAddressPredictions(query, {
          sessionToken: sessionTokenRef.current || undefined,
          locationBias: SUPPORTED_MAP_BOUNDS,
          includedPrimaryTypes: ['street_address', 'premise', 'subpremise'],
        });
        if (requestId !== requestRef.current) return;
        setSuggestions(matches.slice(0, 5));
      } catch (error) {
        if (requestId !== requestRef.current) return;
        setSuggestions([]);
        if (error?.code !== GEOCODING_ERROR_CODES.ZERO_RESULTS) {
          setLookupError(
            error?.isUserFacing
              ? error.message
              : 'Address suggestions are temporarily unavailable. Try again shortly.'
          );
        }
      } finally {
        if (requestId === requestRef.current) setBusy(false);
      }
    }, LOOKUP_DELAY_MS);

    return () => window.clearTimeout(timerRef.current);
  }, [address, city, disabled]);

  useEffect(() => () => {
    requestRef.current += 1;
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  const chooseSuggestion = async (suggestion) => {
    const requestId = ++requestRef.current;
    const sessionToken = sessionTokenRef.current;
    setSuggestions([]);
    setActiveIndex(-1);
    setBusy(true);
    setLookupError('');
    try {
      const originalInput = [address.trim(), city.trim()].filter(Boolean).join(', ');
      const resolved = await resolveAddressSuggestion(suggestion, { sessionToken });
      if (requestId !== requestRef.current) return;
      sessionTokenRef.current = null;
      const validated = validateResolvedOntarioCivicAddress({ ...resolved, originalInput });
      const result = {
        ...validated,
        normalizedAddress: toNormalizedAddressColumns(validated, { originalInput }),
      };
      const resolvedAddress = formatCanonicalStreetAddress(result) || address.trim();
      const resolvedCity = result.components?.city || city.trim();
      suppressedLookupRef.current = addressFingerprint(resolvedAddress, resolvedCity);
      onAddressChange(resolvedAddress);
      onCityChange(resolvedCity);
      onResolved?.(result, { address: resolvedAddress, city: resolvedCity });
    } catch (error) {
      if (requestId !== requestRef.current) return;
      sessionTokenRef.current = null;
      setLookupError(
        error?.isUserFacing
          ? error.message
          : 'That address suggestion could not be verified. Choose it again or try another match.'
      );
    } finally {
      if (requestId === requestRef.current) setBusy(false);
    }
  };

  const handlePickerKeyDown = (event) => {
    if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault();
      setActiveIndex((current) => current < suggestions.length - 1 ? current + 1 : 0);
    } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault();
      setActiveIndex((current) => current > 0 ? current - 1 : suggestions.length - 1);
    } else if (event.key === 'Enter' && suggestions.length > 0) {
      event.preventDefault();
      if (activeIndex >= 0) chooseSuggestion(suggestions[activeIndex]);
      else setActiveIndex(0);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setSuggestions([]);
      setActiveIndex(-1);
    }
  };

  return (
    <div className="address-picker">
      <div className="appraisal-field">
        <label className="appraisal-label" htmlFor={`${prefix}-street`}>{addressLabel}</label>
        <input
          id={`${prefix}-street`}
          className="appraisal-input"
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          aria-controls={listboxId}
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
          autoComplete="street-address"
          value={address}
          disabled={disabled}
          required
          aria-invalid={Boolean(errors.address)}
          aria-describedby={errors.address ? `${prefix}-street-error` : undefined}
          onChange={(event) => {
            suppressedLookupRef.current = '';
            onAddressChange(event.target.value);
          }}
          onKeyDown={handlePickerKeyDown}
        />
        {errors.address && (
          <p id={`${prefix}-street-error`} className="appraisal-field-error">{errors.address}</p>
        )}
      </div>

      <div className="appraisal-field address-picker__city">
        <label className="appraisal-label" htmlFor={`${prefix}-city`}>{cityLabel}</label>
        <input
          id={`${prefix}-city`}
          className="appraisal-input"
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          aria-controls={listboxId}
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
          autoComplete="address-level2"
          placeholder="e.g. Vaughan"
          value={city}
          disabled={disabled}
          required
          aria-invalid={Boolean(errors.city)}
          aria-describedby={errors.city ? `${prefix}-city-error` : lookupError ? `${prefix}-lookup-error` : undefined}
          onChange={(event) => {
            suppressedLookupRef.current = '';
            onCityChange(event.target.value);
          }}
          onKeyDown={handlePickerKeyDown}
        />
        {busy && <span className="address-picker__busy" role="status">Finding matches…</span>}
        {errors.city && (
          <p id={`${prefix}-city-error`} className="appraisal-field-error">{errors.city}</p>
        )}
        {lookupError && !errors.city && (
          <p id={`${prefix}-lookup-error`} className="appraisal-field-warning">{lookupError}</p>
        )}
        {suggestions.length > 0 && (
          <ul id={listboxId} className="address-picker__suggestions" role="listbox">
            {suggestions.map((suggestion, index) => (
              <li
                id={`${listboxId}-${index}`}
                key={suggestion.placeId || suggestion.place_id}
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? 'is-active' : ''}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  chooseSuggestion(suggestion);
                }}
              >
                {suggestion.description}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default AddressPicker;
