import React from 'react';
import {
  GARAGE_CAPACITY_OPTIONS,
  PROPERTY_TYPE_OPTIONS,
} from '../domain/appraisalFields';
import './AppraisalFormFields.css';

function FieldError({ id, message }) {
  if (!message) return null;

  return (
    <p id={id} className="appraisal-field-error">
      {message}
    </p>
  );
}

function AppraisalFormFields({
  reportDate,
  effectiveDate,
  propertyDetails,
  errors = {},
  dateWarning = '',
  disabled = false,
  onReportDateChange,
  onEffectiveDateChange,
  onPropertyDetailChange,
}) {
  return (
    <>
      <div className="appraisal-date-grid">
        <div className="appraisal-field">
          <label className="appraisal-label" htmlFor="appraisal-report-date">
            Report date <span className="appraisal-optional">Optional</span>
          </label>
          <input
            id="appraisal-report-date"
            className="appraisal-input"
            type="date"
            value={reportDate}
            disabled={disabled}
            onChange={(event) => onReportDateChange(event.target.value)}
          />
        </div>

        <div className="appraisal-field">
          <label className="appraisal-label" htmlFor="appraisal-effective-date">
            Effective date <span className="appraisal-optional">Optional</span>
          </label>
          <input
            id="appraisal-effective-date"
            className="appraisal-input"
            type="date"
            value={effectiveDate}
            disabled={disabled}
            aria-describedby={dateWarning ? 'appraisal-date-warning' : undefined}
            onChange={(event) => onEffectiveDateChange(event.target.value)}
          />
        </div>
      </div>

      {dateWarning && (
        <p id="appraisal-date-warning" className="appraisal-field-warning" role="status">
          {dateWarning}
        </p>
      )}

      <fieldset className="appraisal-optional-details" disabled={disabled}>
        <legend>Property facts <span className="appraisal-optional">Optional</span></legend>
        <p className="appraisal-helper">
          Copy only clearly reported facts. Leave a field blank when the report is unclear.
        </p>

        <div className="appraisal-field">
          <label className="appraisal-label" htmlFor="appraisal-property-type">
            Property type
          </label>
          <select
            id="appraisal-property-type"
            className="appraisal-input"
            value={propertyDetails.propertyType}
            disabled={disabled}
            aria-invalid={Boolean(errors.propertyType)}
            aria-describedby={errors.propertyType ? 'appraisal-property-type-error' : undefined}
            onChange={(event) => onPropertyDetailChange('propertyType', event.target.value)}
          >
            <option value="">Not recorded</option>
            {PROPERTY_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <FieldError id="appraisal-property-type-error" message={errors.propertyType} />
        </div>

        <div className="appraisal-property-grid">
          <div className="appraisal-field">
            <label className="appraisal-label" htmlFor="appraisal-living-area">
              Reported living area (square feet)
            </label>
            <div className="appraisal-input-with-unit">
              <input
                id="appraisal-living-area"
                className="appraisal-input"
                type="number"
                inputMode="numeric"
                min="1"
                max="100000"
                step="1"
                placeholder="e.g. 1850"
                value={propertyDetails.reportedLivingAreaSqFt}
                disabled={disabled}
                aria-invalid={Boolean(errors.reportedLivingAreaSqFt)}
                aria-describedby={[
                  'appraisal-living-area-help',
                  errors.reportedLivingAreaSqFt ? 'appraisal-living-area-error' : '',
                ].filter(Boolean).join(' ')}
                onChange={(event) =>
                  onPropertyDetailChange('reportedLivingAreaSqFt', event.target.value)
                }
              />
              <span aria-hidden="true">sq ft</span>
            </div>
            <p id="appraisal-living-area-help" className="appraisal-field-hint">
              Enter square feet from the report. Do not estimate or add basement or garage area.
            </p>
            <FieldError
              id="appraisal-living-area-error"
              message={errors.reportedLivingAreaSqFt}
            />
          </div>

          <div className="appraisal-field">
            <label className="appraisal-label" htmlFor="appraisal-year-built">
              Reported year built
            </label>
            <input
              id="appraisal-year-built"
              className="appraisal-input"
              type="number"
              inputMode="numeric"
              min="1600"
              max={new Date().getFullYear() + 1}
              step="1"
              placeholder="e.g. 1998"
              value={propertyDetails.yearBuilt}
              disabled={disabled}
              aria-invalid={Boolean(errors.yearBuilt)}
              aria-describedby={errors.yearBuilt ? 'appraisal-year-built-error' : undefined}
              onChange={(event) => onPropertyDetailChange('yearBuilt', event.target.value)}
            />
            <FieldError id="appraisal-year-built-error" message={errors.yearBuilt} />
          </div>
        </div>

        <div className="appraisal-property-grid">
          <div className="appraisal-field">
            <label className="appraisal-label" htmlFor="appraisal-garage-capacity">
              Garage capacity
            </label>
            <select
              id="appraisal-garage-capacity"
              className="appraisal-input"
              value={propertyDetails.garageCapacity || ''}
              disabled={disabled}
              aria-invalid={Boolean(errors.garageCapacity)}
              aria-describedby={[
                'appraisal-garage-capacity-help',
                errors.garageCapacity ? 'appraisal-garage-capacity-error' : '',
              ].filter(Boolean).join(' ')}
              onChange={(event) =>
                onPropertyDetailChange('garageCapacity', event.target.value)
              }
            >
              <option value="">Not recorded</option>
              {GARAGE_CAPACITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p id="appraisal-garage-capacity-help" className="appraisal-field-hint">
              Garage spaces as reported. Leave Not recorded when the report is unclear;
              this is not a door count and excludes driveway parking.
            </p>
            <FieldError
              id="appraisal-garage-capacity-error"
              message={errors.garageCapacity}
            />
          </div>

          <div className="appraisal-field">
            <label className="appraisal-label" htmlFor="appraisal-lot-frontage">
              Lot frontage (feet)
            </label>
            <div className="appraisal-input-with-unit">
              <input
                id="appraisal-lot-frontage"
                className="appraisal-input"
                type="text"
                inputMode="decimal"
                placeholder="e.g. 40.5"
                value={propertyDetails.lotFrontageFt ?? ''}
                disabled={disabled || Boolean(propertyDetails.lotFrontageNotApplicable)}
                aria-invalid={Boolean(errors.lotFrontageFt)}
                aria-describedby={[
                  'appraisal-lot-frontage-help',
                  errors.lotFrontageFt ? 'appraisal-lot-frontage-error' : '',
                ].filter(Boolean).join(' ')}
                onChange={(event) =>
                  onPropertyDetailChange('lotFrontageFt', event.target.value)
                }
              />
              <span aria-hidden="true">ft</span>
            </div>
            <p id="appraisal-lot-frontage-help" className="appraisal-field-hint">
              Frontage in feet from the report, up to two decimal places. Do not convert
              metres or estimate.
            </p>
            <FieldError
              id="appraisal-lot-frontage-error"
              message={errors.lotFrontageFt}
            />
            <label className="appraisal-checkbox" htmlFor="appraisal-lot-frontage-not-applicable">
              <input
                id="appraisal-lot-frontage-not-applicable"
                type="checkbox"
                checked={Boolean(propertyDetails.lotFrontageNotApplicable)}
                disabled={disabled}
                aria-describedby="appraisal-lot-frontage-not-applicable-help"
                onChange={(event) => {
                  const checked = event.target.checked;
                  onPropertyDetailChange('lotFrontageNotApplicable', checked);
                  if (checked) onPropertyDetailChange('lotFrontageFt', '');
                }}
              />
              <span>Frontage not applicable</span>
            </label>
            <p id="appraisal-lot-frontage-not-applicable-help" className="appraisal-field-hint">
              Tick only when the report states there is no street frontage to measure,
              such as a condominium unit. Leave both blank when the report does not
              record frontage.
            </p>
          </div>
        </div>
      </fieldset>
    </>
  );
}

export default AppraisalFormFields;
