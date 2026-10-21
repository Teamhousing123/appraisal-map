import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import AddressPicker from './AddressPicker';
import { getAddressPredictions } from '../domain/geocoding';
jest.mock('../domain/geocoding', () => ({ ...jest.requireActual('../domain/geocoding'), getAddressPredictions: jest.fn() }));

beforeEach(() => {
  jest.useFakeTimers();
  getAddressPredictions.mockReset();
  window.google = { maps: { places: {} } };
});
afterEach(() => jest.useRealTimers());

test('does not bill an autocomplete request for an unchanged saved address', () => {
  render(<AddressPicker address="10 Example Road" city="Aurora" onAddressChange={() => {}} onCityChange={() => {}} />);
  act(() => jest.advanceTimersByTime(500));
  expect(getAddressPredictions).not.toHaveBeenCalled();
});

test('ignores an outstanding lookup after the input is cleared', async () => {
  let resolve;
  getAddressPredictions.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const props = { address: '', city: '', onAddressChange: jest.fn(), onCityChange: jest.fn() };
  const { rerender } = render(<AddressPicker {...props} />);
  rerender(<AddressPicker {...props} address="10 Example" />);
  act(() => jest.advanceTimersByTime(300));
  expect(getAddressPredictions).toHaveBeenCalledTimes(1);
  rerender(<AddressPicker {...props} address="" />);
  await act(async () => resolve([{ placeId: 'test', description: 'Old suggestion' }]));
  expect(screen.queryByRole('option')).not.toBeInTheDocument();
  expect(screen.queryByText('Finding matches…')).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByLabelText('Street address'), { key: 'Escape' });
});
