import { describe, it, expect, vi } from 'vitest';
import type { OperationMapEntry } from './operationMap.js';
import type { ConnectorOpIndex, VendorApiSurface } from './operationBinding.js';

/**
 * WHAT HAPPENS WHEN THE VENDOR MOVES.
 *
 * A map entry is a claim about an API that someone else owns and can change without telling
 * us. The entry names a method and its parameters literally, so it is the one part of this
 * system that does NOT adapt by itself -- which makes "what does it do when it goes stale"
 * the load-bearing question for calling any of this dynamic.
 *
 * The answer has to be: refuse, and fall back to deriving the call from shapes. Never send
 * the stale call. These tests pin that, because it was the untested claim holding up every
 * other claim -- `bindWithMap` had no test file at all while being the single decision point
 * every tool and every probe goes through.
 *
 * The caches make the window concrete rather than theoretical: the connector index is
 * re-captured from the customer's environment every 14 days and the vendor surface re-read
 * from Discovery every 30, so an entry CAN be verified against a description newer than it.
 */

const ENTRY: OperationMapEntry = {
  connectorId: 'shared_googledrive',
  operationId: 'GetFileMetadata',
  api: 'drive',
  steps: [{
    vendorMethodId: 'drive.files.get',
    parameters: [{ to: 'fileId', in: 'path', template: '{id}' }],
  }],
  provenance: 'drafted',
};

vi.mock('./maps/index.js', () => ({
  OPERATION_MAP: new Map([['shared_googledrive::GetFileMetadata', ENTRY]]),
  OPERATION_UNMAPPABLE: {},
}));
vi.mock('./vendorSpec.js', () => ({
  resolveVendorApiSurface: async () => undefined,
  vendorApiSurfaceFor: async () => undefined,
}));

const { bindWithMap } = await import('./bindWithMap.js');

const index: ConnectorOpIndex = {
  connectorId: 'shared_googledrive',
  displayName: 'Google Drive',
  operations: {
    GetFileMetadata: {
      method: 'GET',
      path: '/{connectionId}/datasets/default/files/{id}',
      parameters: [{ name: 'id', in: 'path', required: true, type: 'string' }],
    },
  },
} as unknown as ConnectorOpIndex;

/** The vendor as it was when the entry was written. */
const asWritten: VendorApiSurface = {
  api: 'drive',
  schemaVersion: 2,
  methods: [{
    id: 'drive.files.get',
    httpMethod: 'GET',
    url: 'https://www.googleapis.com/drive/v3/files/{fileId}',
    parameters: [{ name: 'fileId', in: 'path', required: true, type: 'string' }],
    hasBody: false,
  }],
};

describe('bindWithMap — when the vendor changes under a stated mapping', () => {
  it('uses the map while the vendor still matches it', async () => {
    const r = await bindWithMap(index, 'GetFileMetadata', asWritten);
    expect(r.status).toBe('bindable');
    if (r.status !== 'bindable') return;
    expect(r.operation.provenance).toBe('vendor-map');
  });

  it('refuses the entry when the vendor no longer publishes the method', async () => {
    const renamed: VendorApiSurface = {
      ...asWritten,
      methods: [{ ...asWritten.methods[0], id: 'drive.files.fetch' }],
    };
    const r = await bindWithMap(index, 'GetFileMetadata', renamed);
    // Asserted unconditionally. A conditional assertion here would pass whenever the call
    // did NOT bind, which is most of the ways this can go wrong.
    const provenance = r.status === 'bindable' ? r.operation.provenance : 'refused';
    expect(provenance).not.toBe('vendor-map');
  });

  it('refuses the entry when the vendor starts requiring a parameter it never fills', async () => {
    const stricter: VendorApiSurface = {
      ...asWritten,
      methods: [{
        ...asWritten.methods[0],
        parameters: [
          ...asWritten.methods[0].parameters!,
          { name: 'tenant', in: 'query', required: true, type: 'string' },
        ],
      }],
    };
    const r = await bindWithMap(index, 'GetFileMetadata', stricter);
    const provenance = r.status === 'bindable' ? r.operation.provenance : 'refused';
    expect(provenance).not.toBe('vendor-map');
  });

  it('never throws when the vendor description cannot be fetched at all', async () => {
    // A Discovery outage must degrade to shape-based binding, not take the migration down.
    const r = await bindWithMap(index, 'GetFileMetadata', undefined);
    expect(['bindable', 'proxy-only', 'not-in-vendor-api', 'no-vendor-binding'])
      .toContain(r.status);
  });
});
