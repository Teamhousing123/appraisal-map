import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PROPERTY_TYPE_OPTIONS } from '../domain/appraisalFields';
import AppraisalFormFields from './AppraisalFormFields';

function renderFields(overrides = {}) {
  const handlers = {
    reportDate: '',
    effectiveDate: '',
    propertyDetails: {
      propertyType: '',
      reportedLivingAreaSqFt: '',
      yearBuilt: '',
      garageCapacity: '',
      lotFrontageFt: '',
    },
    onReportDateChange: jest.fn(),
    onEffectiveDateChange: jest.fn(),
    onPropertyDetailChange: jest.fn(),
    ...overrides,
  };

  render(<AppraisalFormFields {...handlers} />);
  return handlers;
}

test('renders labelled report and optional property fields', () => {
  renderFields();

  expect(screen.getByLabelText(/Report date/i)).toHaveAttribute('type', 'date');
  expect(screen.getByLabelText(/Effective date/i)).toHaveAttribute('type', 'date');
  expect(screen.getByRole('group', { name: /Property facts.*Optional/i })).toBeVisible();
  expect(screen.getByLabelText('Property type')).toBeInTheDocument();
  expect(screen.getByLabelText(/Reported living area \(square feet\)/i)).toHaveAttribute('type', 'number');
  expect(screen.getByLabelText('Reported year built')).toHaveAttribute('type', 'number');
});

test('reports field changes using the shared property-detail names', () => {
  const view = renderFields();
  const firstPropertyType = PROPERTY_TYPE_OPTIONS[0].value;

  fireEvent.change(screen.getByLabelText('Property type'), {
    target: { value: firstPropertyType },
  });
  fireEvent.change(screen.getByLabelText(/Reported living area \(square feet\)/i), {
    target: { value: '1850' },
  });
  fireEvent.change(screen.getByLabelText('Reported year built'), {
    target: { value: '1998' },
  });

  expect(view.onPropertyDetailChange).toHaveBeenNthCalledWith(
    1,
    'propertyType',
    firstPropertyType
  );
  expect(view.onPropertyDetailChange).toHaveBeenNthCalledWith(
    2,
    'reportedLivingAreaSqFt',
    '1850'
  );
  expect(view.onPropertyDetailChange).toHaveBeenNthCalledWith(3, 'yearBuilt', '1998');
});

test('associates validation and date warnings with their inputs', () => {
  renderFields({
    dateWarning: 'Effective date is after the report date.',
    errors: {
      reportedLivingAreaSqFt: 'Enter a whole number greater than zero.',
    },
  });

  expect(screen.getByRole('status')).toHaveTextContent(
    'Effective date is after the report date.'
  );
  expect(screen.getByLabelText(/Reported living area \(square feet\)/i)).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText(/Reported living area \(square feet\)/i))
    .toHaveAttribute('aria-describedby', 'appraisal-living-area-help appraisal-living-area-error');
  expect(screen.getByText('Enter a whole number greater than zero.')).toBeInTheDocument();
});

test('keeps stored property facts visible without opening a disclosure', () => {
  renderFields({
    propertyDetails: {
      propertyType: PROPERTY_TYPE_OPTIONS[0].value,
      reportedLivingAreaSqFt: '',
      yearBuilt: '',
    },
  });

  expect(screen.getByRole('group')).toBeVisible();
  expect(screen.getByLabelText('Property type')).toBeVisible();
  expect(screen.getByLabelText('Property type')).toHaveValue(PROPERTY_TYPE_OPTIONS[0].value);
});

test('renders the garage and frontage controls with labels, hints, and ids', () => {
  renderFields();

  const fieldset = screen.getByRole('group', { name: /Property facts/i });
  const garage = within(fieldset).getByLabelText('Garage capacity');
  expect(garage).toHaveAttribute('id', 'appraisal-garage-capacity');
  expect(within(garage).getAllByRole('option').map((option) => option.textContent)).toEqual([
    'Not recorded',
    'None',
    'Single',
    'Double',
    'Triple',
    '4+',
    'Other',
    'Not applicable',
  ]);
  expect(garage.getAttribute('aria-describedby')).toContain('appraisal-garage-capacity-help');
  expect(within(fieldset).getByText(/Garage spaces as reported/i)).toBeInTheDocument();

  const frontage = within(fieldset).getByLabelText('Lot frontage (feet)');
  expect(frontage).toHaveAttribute('id', 'appraisal-lot-frontage');
  expect(frontage).toHaveAttribute('type', 'text');
  expect(frontage).toHaveAttribute('inputmode', 'decimal');
  expect(frontage.getAttribute('aria-describedby')).toContain('appraisal-lot-frontage-help');
  expect(within(fieldset).getByText(/Do not convert metres or estimate/i)).toBeInTheDocument();

  expect(fieldset).toHaveTextContent(/Reported year built.*Garage capacity.*Lot frontage/);
});

test('reports garage and frontage edits through onPropertyDetailChange', () => {
  const view = renderFields();

  fireEvent.change(screen.getByLabelText('Garage capacity'), { target: { value: 'double' } });
  fireEvent.change(screen.getByLabelText('Lot frontage (feet)'), { target: { value: '40.5' } });

  expect(view.onPropertyDetailChange).toHaveBeenNthCalledWith(1, 'garageCapacity', 'double');
  expect(view.onPropertyDetailChange).toHaveBeenNthCalledWith(2, 'lotFrontageFt', '40.5');
});

test('associates garage and frontage errors with their inputs', () => {
  renderFields({
    errors: {
      garageCapacity: 'Choose a valid garage capacity.',
      lotFrontageFt: 'Enter the lot frontage in feet as a number with up to two decimal places, for example 40.5. Do not include units.',
    },
  });

  const garage = screen.getByLabelText('Garage capacity');
  expect(garage).toHaveAttribute('aria-invalid', 'true');
  expect(garage.getAttribute('aria-describedby')).toContain('appraisal-garage-capacity-error');
  expect(screen.getByText('Choose a valid garage capacity.')).toBeInTheDocument();

  const frontage = screen.getByLabelText('Lot frontage (feet)');
  expect(frontage).toHaveAttribute('aria-invalid', 'true');
  expect(frontage.getAttribute('aria-describedby')).toContain('appraisal-lot-frontage-error');
  expect(screen.getByText(/Enter the lot frontage in feet as a number/i)).toBeInTheDocument();
});
