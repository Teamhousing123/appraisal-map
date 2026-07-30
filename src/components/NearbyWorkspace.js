import React, { useEffect, useMemo, useState } from 'react';
import {
  PROPERTY_TYPE_OPTIONS,
  formatPropertyType,
  validatePropertyDetails,
} from '../domain/appraisalFields';
import {
  calculateLivingAreaDifference,
  calculateYearBuiltDifference,
  formatLivingAreaDifference,
  formatYearBuiltDifference,
} from '../domain/comparison';

const NOT_RECORDED = 'Not recorded';
const REPORT_BATCH_SIZE = 60;

function ArrowIcon({ direction = 'right' }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      width="18"
      height="18"
      className={direction === 'left' ? 'icon-rotate-180' : undefined}
    >
      <path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DocumentIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18" fill="none">
      <path d="M5 2.75h6l4 4v10.5H5V2.75Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M11 2.75v4h4M7.5 10h5M7.5 13h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function formatArea(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? `${parsed.toLocaleString('en-CA')} sq ft` : NOT_RECORDED;
}

function formatYear(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? String(parsed) : NOT_RECORDED;
}

function formatDistance(value) {
  if (!Number.isFinite(value)) return 'Distance unavailable';
  if (value < 1) return `${Math.max(1, Math.round(value * 1000))} m away`;
  return `${value.toFixed(value < 10 ? 1 : 0)} km away`;
}

function reportReferenceDate(report) {
  if (report.effective_date) {
    return { label: 'Effective', formatted: report._formattedEffectiveDate || report.effective_date };
  }
  if (report.appraisal_date) {
    return { label: 'Report', formatted: report._formattedReportDate || report.appraisal_date };
  }
  return { label: 'Report date', formatted: NOT_RECORDED };
}

function SubjectFactError({ id, message }) {
  if (!message) return null;
  return <p id={id} className="field-error" role="alert">{message}</p>;
}

function SubjectFacts({ subject, errors, onChange }) {
  return (
    <details className="subject-facts">
      <summary>
        <span>Subject property facts</span>
        <span className="subject-facts__summary">Optional · this session only</span>
      </summary>
      <p>Enter only facts you know. They are used for factual differences and are not saved.</p>
      <div className="subject-facts__grid">
        <label htmlFor="subject-property-type">
          <span>Property type</span>
          <select
            id="subject-property-type"
            aria-label="Property type"
            value={subject.propertyType}
            aria-invalid={Boolean(errors.propertyType)}
            aria-describedby={errors.propertyType ? 'subject-property-type-error' : undefined}
            onChange={(event) => onChange('propertyType', event.target.value)}
          >
            <option value="">Not recorded</option>
            {PROPERTY_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <SubjectFactError id="subject-property-type-error" message={errors.propertyType} />
        </label>
        <label htmlFor="subject-living-area">
          <span>Living area (sq ft)</span>
          <span className="input-with-unit">
            <input
              id="subject-living-area"
              aria-label="Living area in square feet"
              type="number"
              min="1"
              max="100000"
              step="1"
              inputMode="numeric"
              value={subject.reportedLivingAreaSqFt}
              aria-invalid={Boolean(errors.reportedLivingAreaSqFt)}
              aria-describedby={
                errors.reportedLivingAreaSqFt ? 'subject-living-area-error' : undefined
              }
              onChange={(event) => onChange('reportedLivingAreaSqFt', event.target.value)}
            />
            <i>sq ft</i>
          </span>
          <SubjectFactError
            id="subject-living-area-error"
            message={errors.reportedLivingAreaSqFt}
          />
        </label>
        <label htmlFor="subject-year-built">
          <span>Year built</span>
          <input
            id="subject-year-built"
            aria-label="Year built"
            type="number"
            min="1600"
            max={new Date().getFullYear() + 1}
            step="1"
            inputMode="numeric"
            value={subject.yearBuilt}
            aria-invalid={Boolean(errors.yearBuilt)}
            aria-describedby={errors.yearBuilt ? 'subject-year-built-error' : undefined}
            onChange={(event) => onChange('yearBuilt', event.target.value)}
          />
          <SubjectFactError id="subject-year-built-error" message={errors.yearBuilt} />
        </label>
      </div>
    </details>
  );
}

function normalizeMissingCount(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : 0;
}

function describeMissingReports(count, missingDetail, filterName) {
  return `${count} report${count === 1 ? '' : 's'} ${missingDetail} ${
    count === 1 ? 'is' : 'are'
  } excluded by the ${filterName}.`;
}

function Filters({
  filters,
  subject,
  onChange,
  onReset,
  activeCount,
  missingFilterCounts = {},
}) {
  const omissionMessages = [];
  const missingPropertyType = normalizeMissingCount(missingFilterCounts.propertyType);
  const missingReferenceDate = normalizeMissingCount(missingFilterCounts.referenceDate);
  const missingCoordinates = normalizeMissingCount(missingFilterCounts.coordinates);

  if (filters.propertyType && missingPropertyType > 0) {
    omissionMessages.push(describeMissingReports(
      missingPropertyType,
      'without a recorded property type',
      'property-type filter'
    ));
  }
  if ((filters.dateFrom || filters.dateTo) && missingReferenceDate > 0) {
    omissionMessages.push(describeMissingReports(
      missingReferenceDate,
      'without an effective or report date',
      'reference-date filter'
    ));
  }
  if (filters.radiusKm && missingCoordinates > 0) {
    omissionMessages.push(describeMissingReports(
      missingCoordinates,
      'without a mapped location',
      'radius filter'
    ));
  }

  return (
    <details className="report-filters" open={activeCount > 0}>
      <summary>
        <span>Filter reports</span>
        <span>{activeCount > 0 ? `${activeCount} active` : 'Optional'}</span>
      </summary>
      <div className="report-filters__grid">
        <label>
          <span>Radius</span>
          <select
            value={filters.radiusKm}
            disabled={!subject}
            onChange={(event) => onChange('radiusKm', event.target.value)}
          >
            <option value="">Map area</option>
            <option value="2">Within 2 km</option>
            <option value="5">Within 5 km</option>
            <option value="10">Within 10 km</option>
            <option value="25">Within 25 km</option>
            <option value="50">Within 50 km</option>
          </select>
        </label>
        <label>
          <span>Property type</span>
          <select value={filters.propertyType} onChange={(event) => onChange('propertyType', event.target.value)}>
            <option value="">All types</option>
            {PROPERTY_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Reference date from</span>
          <input type="date" value={filters.dateFrom} onChange={(event) => onChange('dateFrom', event.target.value)} />
        </label>
        <label>
          <span>Reference date to</span>
          <input type="date" value={filters.dateTo} onChange={(event) => onChange('dateTo', event.target.value)} />
        </label>
        <label className="report-filters__sort">
          <span>Sort</span>
          <select value={filters.sortBy} onChange={(event) => onChange('sortBy', event.target.value)}>
            <option value="distance" disabled={!subject}>Nearest first</option>
            <option value="newest">Newest reference date first</option>
          </select>
        </label>
      </div>
      <div className="report-filters__footer">
        <p aria-live="polite">
          Reference date uses the effective date when recorded; otherwise it uses the report date.
          {omissionMessages.length > 0 ? ` ${omissionMessages.join(' ')}` : ''}
        </p>
        <button type="button" className="button button--quiet" onClick={onReset} disabled={activeCount === 0}>
          Clear filters
        </button>
      </div>
    </details>
  );
}

function ReportCard({
  report,
  selected,
  selectionDisabled,
  onToggle,
  onDetails,
  onOpenReport,
  openingReport,
  onHover,
}) {
  const date = reportReferenceDate(report);
  const hasMetadata = report.property_type || report.reported_living_area_sq_ft || report.year_built;
  const hasDocument = report.pdf_url || report.folder_files?.length;

  return (
    <article
      className={`report-card${selected ? ' is-selected' : ''}`}
      onMouseEnter={() => onHover(report.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(report.id)}
    >
      <div className="report-card__topline">
        <p>{formatDistance(report._distanceKm)}</p>
        {report.locationCount > 1 && report.locationIndex === 0 && (
          <span>{report.locationCount} reports here</span>
        )}
      </div>
      <h3>{report.address}</h3>
      <p className="report-card__city">{report.city}</p>
      <dl className="report-card__facts">
        <div>
          <dt>{date.label}</dt>
          <dd>{date.formatted}</dd>
        </div>
        {hasMetadata && (
          <>
            <div>
              <dt>Type</dt>
              <dd>{formatPropertyType(report.property_type) || NOT_RECORDED}</dd>
            </div>
            <div>
              <dt>Living area</dt>
              <dd>{formatArea(report.reported_living_area_sq_ft)}</dd>
            </div>
            <div>
              <dt>Year built</dt>
              <dd>{formatYear(report.year_built)}</dd>
            </div>
          </>
        )}
      </dl>
      {!hasMetadata && <p className="report-card__sparse">Property details not recorded</p>}
      <div className="report-card__actions">
        <button
          type="button"
          className="button button--report"
          onClick={() => onOpenReport(report)}
          disabled={!hasDocument || openingReport}
        >
          <DocumentIcon />
          {openingReport ? 'Opening…' : hasDocument ? 'Open report' : 'No report file'}
        </button>
        <button type="button" className="button button--quiet" onClick={() => onDetails(report)}>
          Details <ArrowIcon />
        </button>
      </div>
      <label className={`candidate-toggle${selected ? ' is-selected' : ''}${selectionDisabled ? ' is-disabled' : ''}`}>
        <input
          type="checkbox"
          checked={selected}
          disabled={selectionDisabled}
          onChange={() => onToggle(report)}
        />
        <span aria-hidden="true" />
        {selected ? 'Selected for comparison' : 'Select as candidate'}
      </label>
    </article>
  );
}

function getAreaDifference(subject, candidate) {
  return formatLivingAreaDifference(calculateLivingAreaDifference(
    subject.reportedLivingAreaSqFt,
    candidate.reported_living_area_sq_ft
  )) || NOT_RECORDED;
}

function getYearDifference(subject, candidate) {
  return formatYearBuiltDifference(calculateYearBuiltDifference(
    subject.yearBuilt,
    candidate.year_built
  )) || NOT_RECORDED;
}

const comparisonRows = [
  { label: 'Property type', subject: (subject) => formatPropertyType(subject.propertyType) || NOT_RECORDED, candidate: (subject, candidate) => formatPropertyType(candidate.property_type) || NOT_RECORDED },
  { label: 'Reported living area', subject: (subject) => formatArea(subject.reportedLivingAreaSqFt), candidate: (subject, candidate) => formatArea(candidate.reported_living_area_sq_ft) },
  { label: 'Living area difference', subject: () => 'Reference', candidate: getAreaDifference },
  { label: 'Reported year built', subject: (subject) => formatYear(subject.yearBuilt), candidate: (subject, candidate) => formatYear(candidate.year_built) },
  { label: 'Year difference', subject: () => 'Reference', candidate: getYearDifference },
  { label: 'Reference date', alwaysVisible: true, subject: () => 'Not applicable', candidate: (subject, candidate) => {
    const date = reportReferenceDate(candidate);
    return `${date.label}: ${date.formatted}`;
  } },
  { label: 'Straight-line distance', alwaysVisible: true, subject: () => '0 km', candidate: (subject, candidate) => formatDistance(candidate._distanceKm).replace(' away', '') },
];

function getVisibleComparisonRows(subject, candidates) {
  return comparisonRows.filter((row) => (
    row.alwaysVisible
    || candidates.some((candidate) => row.candidate(subject, candidate) !== NOT_RECORDED)
  ));
}

function hasReportDocument(candidate) {
  return Boolean(candidate.pdf_url || candidate.folder_files?.length);
}

function ComparisonView({ subject, candidates, onBack, onRemove, onOpenReport, openingReportId }) {
  const visibleComparisonRows = getVisibleComparisonRows(subject, candidates);

  return (
    <section className="comparison-view" aria-labelledby="comparison-title">
      <div className="workspace-heading workspace-heading--with-back">
        <button type="button" className="icon-button" onClick={onBack} aria-label="Back to nearby reports">
          <ArrowIcon direction="left" />
        </button>
        <h2 id="comparison-title">Compare selected candidates</h2>
      </div>
      <p className="comparison-caveat">
        Differences are candidate minus subject and factual only. A positive number does not mean
        better or more comparable. No valuation adjustment, ranking, or recommendation is calculated.
      </p>

      <div className="comparison-desktop" tabIndex="0" aria-label="Subject and candidate comparison table">
        <table>
          <thead>
            <tr>
              <th scope="col">Fact</th>
              <th scope="col" className="comparison-subject-heading">
                <span>Subject</span>
                <strong>{subject.address}</strong>
              </th>
              {candidates.map((candidate) => (
                <th scope="col" key={candidate.id}>
                  <span>Candidate</span>
                  <strong>{candidate.address}</strong>
                  <button type="button" onClick={() => onRemove(candidate.id)}>Remove</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleComparisonRows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.subject(subject)}</td>
                {candidates.map((candidate) => <td key={candidate.id}>{row.candidate(subject, candidate)}</td>)}
              </tr>
            ))}
            <tr className="comparison-report-row">
              <th scope="row">Source report</th>
              <td>Current subject</td>
              {candidates.map((candidate) => (
                <td key={candidate.id}>
                  <button
                    type="button"
                    className="button button--report"
                    onClick={() => onOpenReport(candidate)}
                    disabled={!hasReportDocument(candidate) || openingReportId === candidate.id}
                  >
                    <DocumentIcon /> {openingReportId === candidate.id
                      ? 'Opening…'
                      : hasReportDocument(candidate) ? 'Open original report' : 'No report file'}
                  </button>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="comparison-mobile">
        <div className="comparison-mobile__subject">
          <span>Subject</span>
          <strong>{subject.address}</strong>
        </div>
        {candidates.map((candidate) => (
          <article key={candidate.id} className="comparison-mobile__card">
            <header>
              <div><span>Candidate</span><h3>{candidate.address}</h3></div>
              <button type="button" onClick={() => onRemove(candidate.id)}>Remove</button>
            </header>
            <dl>
              {visibleComparisonRows.map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd><span>Subject</span>{row.subject(subject)}</dd>
                  <dd><span>Candidate</span>{row.candidate(subject, candidate)}</dd>
                </div>
              ))}
            </dl>
            <button
              type="button"
              className="button button--report"
              onClick={() => onOpenReport(candidate)}
              disabled={!hasReportDocument(candidate) || openingReportId === candidate.id}
            >
              <DocumentIcon /> {openingReportId === candidate.id
                ? 'Opening…'
                : hasReportDocument(candidate) ? 'Open original report' : 'No report file'}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function NearbyWorkspace({
  subject,
  onSubjectFactChange,
  reports,
  unfilteredCount,
  loading,
  error,
  truncated,
  filters,
  activeFilterCount,
  missingFilterCounts,
  onFilterChange,
  onResetFilters,
  candidateIds,
  candidates,
  onToggleCandidate,
  onOpenDetails,
  onOpenReport,
  openingReportId,
  onHoverReport,
  view,
  onCompare,
  onBackFromCompare,
  onRemoveCandidate,
  onRetry,
}) {
  const [visibleReportCount, setVisibleReportCount] = useState(REPORT_BATCH_SIZE);
  const reportResultKey = useMemo(
    () => reports.map((report) => String(report.id)).join('\u001f'),
    [reports]
  );

  useEffect(() => {
    setVisibleReportCount(REPORT_BATCH_SIZE);
  }, [reportResultKey]);

  const visibleReports = reports.slice(0, visibleReportCount);
  const remainingReportCount = Math.max(0, reports.length - visibleReports.length);
  const nextBatchSize = Math.min(REPORT_BATCH_SIZE, remainingReportCount);
  const subjectFactErrors = subject ? validatePropertyDetails(subject) : {};
  const validatedSubject = subject ? {
    ...subject,
    propertyType: subjectFactErrors.propertyType ? null : subject.propertyType,
    reportedLivingAreaSqFt: subjectFactErrors.reportedLivingAreaSqFt
      ? null
      : subject.reportedLivingAreaSqFt,
    yearBuilt: subjectFactErrors.yearBuilt ? null : subject.yearBuilt,
  } : subject;

  if (view === 'compare') {
    return (
      <ComparisonView
        subject={validatedSubject}
        candidates={candidates}
        onBack={onBackFromCompare}
        onRemove={onRemoveCandidate}
        onOpenReport={onOpenReport}
        openingReportId={openingReportId}
      />
    );
  }

  return (
    <section className="nearby-workspace" aria-labelledby="nearby-title">
      <div className="workspace-heading">
        <h2 id="nearby-title">{subject ? 'Reports near this property' : 'Reports in this map area'}</h2>
        <span className="result-count" aria-label={`${reports.length} matching reports`}>
          {reports.length}
        </span>
      </div>
      <p className="workspace-intro">
        {subject
          ? 'Nearby reports are starting points, not appraiser-selected comparables.'
          : 'Search for a subject property to calculate distance and compare physical facts.'}
      </p>

      {subject && (
        <SubjectFacts
          subject={subject}
          errors={subjectFactErrors}
          onChange={onSubjectFactChange}
        />
      )}
      <Filters
        filters={filters}
        subject={subject}
        activeCount={activeFilterCount}
        missingFilterCounts={missingFilterCounts}
        onChange={onFilterChange}
        onReset={onResetFilters}
      />

      {truncated && (
        <div className="workspace-notice" role="status">
          This area contains more reports than the current display limit. Zoom in to narrow the map area.
        </div>
      )}

      <div id="nearby-report-list-status" className="report-list-status" aria-live="polite">
        {loading
          ? `Updating reports in this map area… ${visibleReports.length} of ${reports.length} matching reports currently visible`
          : `Showing ${visibleReports.length} of ${reports.length} matching reports`}
      </div>

      {error ? (
        <div className="workspace-state workspace-state--error" role="alert">
          <h3>Reports could not be loaded</h3>
          <p>{error}</p>
          <button type="button" className="button button--secondary" onClick={onRetry}>Try again</button>
        </div>
      ) : reports.length === 0 && !loading ? (
        <div className="workspace-state">
          <span className="workspace-state__target" aria-hidden="true" />
          <h3>{unfilteredCount > 0 ? 'No reports match these filters' : 'No reports in this map area'}</h3>
          <p>{unfilteredCount > 0 ? 'Clear the filters to bring nearby reports back.' : 'Pan or zoom out to look in a wider area.'}</p>
          {unfilteredCount > 0 && <button type="button" className="button button--secondary" onClick={onResetFilters}>Clear filters</button>}
        </div>
      ) : (
        <div id="nearby-report-list" className="report-list" aria-busy={loading}>
          {visibleReports.map((report) => (
            <ReportCard
              key={report.id}
              report={report}
              selected={candidateIds.includes(report.id)}
              selectionDisabled={
                !subject
                || (!candidateIds.includes(report.id) && candidateIds.length >= 3)
              }
              onToggle={onToggleCandidate}
              onDetails={onOpenDetails}
              onOpenReport={onOpenReport}
              openingReport={openingReportId === report.id}
              onHover={onHoverReport}
            />
          ))}
          {remainingReportCount > 0 && (
            <button
              type="button"
              className="button button--secondary"
              aria-controls="nearby-report-list"
              aria-describedby="nearby-report-list-status"
              onClick={() => setVisibleReportCount((current) => (
                Math.min(current + REPORT_BATCH_SIZE, reports.length)
              ))}
            >
              Show {nextBatchSize} more
            </button>
          )}
        </div>
      )}

      {candidateIds.length > 0 && (
        <div className="compare-tray" role="region" aria-label="Selected candidates">
          <div>
            <strong>{candidateIds.length} of 3 selected</strong>
            <span>Select reports worth a closer look</span>
          </div>
          <button type="button" className="button button--primary" onClick={onCompare}>
            Compare <ArrowIcon />
          </button>
        </div>
      )}
    </section>
  );
}

export default NearbyWorkspace;
