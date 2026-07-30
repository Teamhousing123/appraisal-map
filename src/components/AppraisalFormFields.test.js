import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
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
  expect(screen.getByText('Property details (optional)')).toBeInTheDocument();
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
