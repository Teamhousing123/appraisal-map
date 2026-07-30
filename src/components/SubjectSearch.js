import React, { useId } from 'react';

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none">
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function SubjectSearch({
  value,
  onChange,
  onSubmit,
  suggestions,
  activeSuggestionIndex,
  onActiveSuggestionChange,
  onSuggestionSelect,
  subject,
  onClear,
  busy = false,
  error = '',
}) {
  const listboxId = useId();
  const inputId = useId();

  const handleKeyDown = (event) => {
    if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault();
      onActiveSuggestionChange(
        activeSuggestionIndex < suggestions.length - 1 ? activeSuggestionIndex + 1 : 0
      );
      return;
    }

    if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault();
      onActiveSuggestionChange(
        activeSuggestionIndex > 0 ? activeSuggestionIndex - 1 : suggestions.length - 1
      );
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onActiveSuggestionChange(-1, { close: true });
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (activeSuggestionIndex >= 0 && suggestions[activeSuggestionIndex]) {
        onSuggestionSelect(suggestions[activeSuggestionIndex]);
      } else {
        onSubmit();
      }
    }
  };

  return (
    <div className="subject-search">
      <div className="subject-search__field">
        <label htmlFor={inputId} className="sr-only">
          Search for a subject property
        </label>
        <span className="subject-search__icon"><SearchIcon /></span>
        <input
          id={inputId}
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          aria-controls={listboxId}
          aria-activedescendant={
            activeSuggestionIndex >= 0 ? `${listboxId}-option-${activeSuggestionIndex}` : undefined
          }
          autoComplete="off"
          placeholder="Search for a subject property"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          className="subject-search__input"
        />
        {busy && <span className="subject-search__busy" role="status">Searching</span>}
        {suggestions.length > 0 && (
          <ul id={listboxId} role="listbox" className="subject-search__suggestions">
            {suggestions.map((suggestion, index) => (
              <li
                id={`${listboxId}-option-${index}`}
                key={suggestion.place_id}
                role="option"
                aria-selected={index === activeSuggestionIndex}
                className={index === activeSuggestionIndex ? 'is-active' : ''}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSuggestionSelect(suggestion);
                }}
                onMouseEnter={() => onActiveSuggestionChange(index)}
              >
                <span className="subject-search__suggestion-pin" aria-hidden="true" />
                <span>{suggestion.description}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {subject && (
        <button
          type="button"
          className="subject-search__clear"
          onClick={onClear}
          aria-label={`Clear subject ${subject.address}`}
        >
          <span className="subject-search__clear-copy">
            <span>{subject.address}</span>
          </span>
          <span aria-hidden="true">×</span>
        </button>
      )}
      {error && <p className="subject-search__error" role="alert">{error}</p>}
    </div>
  );
}

export default SubjectSearch;
