import { describe, it, expect } from 'vitest';
import { checkCatalogPin, catalogPinKey, withCatalogPins } from './catalogPinning.js';

/**
 * The property under test: a RETRY must reproduce the ORIGINAL run, never silently drift
 * because the catalog changed in between. See orchestrator.ts's wiring, right after
 * `buildBoundToolSpecs`, for where this actually gates a real deploy.
 */
describe('checkCatalogPin', () => {
  it('is "first-time" when nothing has been pinned yet for this agent', () => {
    expect(checkCatalogPin(undefined, 'shared_office365users', 'GetUserV2', 1)).toEqual({ status: 'first-time' });
    expect(checkCatalogPin({}, 'shared_office365users', 'GetUserV2', 1)).toEqual({ status: 'first-time' });
  });

  it('is "match" when the pinned version equals the current one — a faithful retry', () => {
    const pins = { [catalogPinKey('shared_office365users', 'GetUserV2')]: 1 };
    expect(checkCatalogPin(pins, 'shared_office365users', 'GetUserV2', 1)).toEqual({ status: 'match' });
  });

  it('is "conflict" when the catalog has moved since this agent was first staged', () => {
    const pins = { [catalogPinKey('shared_office365users', 'GetUserV2')]: 1 };
    expect(checkCatalogPin(pins, 'shared_office365users', 'GetUserV2', 2)).toEqual({
      status: 'conflict',
      pinnedVersion: 1,
      currentVersion: 2,
    });
  });

  it('keys are per (connector, operation) — a pin on one operation never affects another', () => {
    const pins = { [catalogPinKey('shared_office365users', 'GetUserV2')]: 1 };
    expect(checkCatalogPin(pins, 'shared_office365users', 'Manager_V2', 5)).toEqual({ status: 'first-time' });
    expect(checkCatalogPin(pins, 'shared_other_connector', 'GetUserV2', 5)).toEqual({ status: 'first-time' });
  });
});

describe('withCatalogPins', () => {
  it('adds a new pin without disturbing existing ones on other operations', () => {
    const existing = { [catalogPinKey('shared_office365users', 'GetUserV2')]: 1 };
    const next = withCatalogPins(existing, [
      { connectorId: 'shared_office365users', sourceOperationId: 'Manager_V2', catalogVersion: 1 },
    ]);
    expect(next[catalogPinKey('shared_office365users', 'GetUserV2')]).toBe(1);
    expect(next[catalogPinKey('shared_office365users', 'Manager_V2')]).toBe(1);
    // Original object untouched — callers must not assume in-place mutation.
    expect(existing[catalogPinKey('shared_office365users', 'Manager_V2')]).toBeUndefined();
  });

  it('starts fresh when there is no existing pin map', () => {
    const next = withCatalogPins(undefined, [
      { connectorId: 'shared_office365users', sourceOperationId: 'GetUserV2', catalogVersion: 1 },
    ]);
    expect(next).toEqual({ [catalogPinKey('shared_office365users', 'GetUserV2')]: 1 });
  });
});
