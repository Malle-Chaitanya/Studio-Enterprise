import { describe, it, expect } from 'vitest';
import { mergeOverrideMap } from './identityMap.js';

/**
 * The behaviour under test is DO NOT DESTROY WHAT YOU WERE NOT TOLD ABOUT.
 *
 * The Map-users screens save only the subset they are holding — the freshly auto-matched
 * pairs, or the pending draft. When the save replaced the stored map wholesale, every
 * mapping that happened to be off screen was deleted, silently. Nothing failed at the time;
 * it surfaced migrations later as a run reporting zero identity overrides, and the per-caller
 * connectors then fail-closed for every caller because no mapping could resolve them.
 *
 * So absence must mean "I have nothing to say about this key", and only an explicit blank
 * may delete.
 */

const lower = (k: string): string => k.trim().toLowerCase();

describe('mergeOverrideMap', () => {
  it('keeps mappings the caller never mentioned', () => {
    const current = { 'erik@filefuze.co': 'admin@migrationn.com', 'ron@filefuze.co': 'ron@migrationn.com' };
    const incoming = { 'ben@filefuze.co': 'ben@migrationn.com' };
    expect(mergeOverrideMap(current, incoming, incoming, lower)).toEqual({
      'erik@filefuze.co': 'admin@migrationn.com',
      'ron@filefuze.co': 'ron@migrationn.com',
      'ben@filefuze.co': 'ben@migrationn.com',
    });
  });

  it('a partial save of one pair does not wipe the other four', () => {
    const current = {
      'erik@filefuze.co': 'admin@migrationn.com',
      'alex@filefuze.co': 'alex@migrationn.com',
      'ben@filefuze.co': 'ben@migrationn.com',
      'dan@fuzebot.io': 'dan@migrationn.com',
      'ron@filefuze.co': 'ron@migrationn.com',
    };
    const incoming = { 'ron@filefuze.co': 'ron@migrationn.com' };
    expect(Object.keys(mergeOverrideMap(current, incoming, incoming, lower))).toHaveLength(5);
  });

  it('an empty incoming map changes nothing', () => {
    const current = { 'erik@filefuze.co': 'admin@migrationn.com' };
    expect(mergeOverrideMap(current, {}, {}, lower)).toEqual(current);
  });

  it('overwrites a mapping the caller does mention', () => {
    const current = { 'erik@filefuze.co': 'old@migrationn.com' };
    const incoming = { 'erik@filefuze.co': 'admin@migrationn.com' };
    expect(mergeOverrideMap(current, incoming, incoming, lower)).toEqual({
      'erik@filefuze.co': 'admin@migrationn.com',
    });
  });

  it('an explicit blank value unmaps that one person', () => {
    const current = { 'erik@filefuze.co': 'admin@migrationn.com', 'ron@filefuze.co': 'ron@migrationn.com' };
    // The sanitizer drops empty values, so the blank survives only in `raw`.
    expect(mergeOverrideMap(current, {}, { 'ron@filefuze.co': '' }, lower)).toEqual({
      'erik@filefuze.co': 'admin@migrationn.com',
    });
  });

  it('unmapping is case- and whitespace-insensitive on the key', () => {
    const current = { 'ron@filefuze.co': 'ron@migrationn.com' };
    expect(mergeOverrideMap(current, {}, { '  RON@FileFuze.co ': '   ' }, lower)).toEqual({});
  });

  it('does not mutate the stored map it was handed', () => {
    const current = { 'erik@filefuze.co': 'admin@migrationn.com' };
    const incoming = { 'ben@filefuze.co': 'ben@migrationn.com' };
    mergeOverrideMap(current, incoming, incoming, lower);
    expect(current).toEqual({ 'erik@filefuze.co': 'admin@migrationn.com' });
  });
});
