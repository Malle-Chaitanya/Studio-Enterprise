import { describe, it, expect } from 'vitest';
import { verifyMapEntry, indexOperationMap, lookupMapEntry } from './operationMap.js';
import type { OperationMapEntry } from './operationMap.js';
import type { ConnectorOpIndex, VendorApiSurface } from './operationBinding.js';

/**
 * The structural gate, tested from the rejection side first.
 *
 * An entry in this map says "this Power Platform operation IS this vendor call". Nothing at
 * run time can tell that a wrong one is wrong — it returns the wrong rows, with a 200. So
 * the value of this gate is entirely in what it REFUSES, and a test suite that only proves
 * the happy path proves nothing about the risk. Each case below is a way a drafted entry
 * can be wrong while still looking plausible to a reader.
 */

const DRIVE: VendorApiSurface = {
  api: 'drive',
  schemaVersion: 2,
  commonParameters: [
    { name: 'alt', in: 'query', required: false, type: 'string', enum: ['json', 'media'] },
    { name: 'fields', in: 'query', required: false, type: 'string' },
  ],
  methods: [
    {
      id: 'drive.files.get',
      httpMethod: 'GET',
      url: 'https://www.googleapis.com/drive/v3/files/{fileId}',
      parameters: [
        { name: 'fileId', in: 'path', required: true, type: 'string' },
        { name: 'supportsAllDrives', in: 'query', required: false, type: 'boolean' },
      ],
      hasBody: false,
    },
    {
      id: 'drive.files.list',
      httpMethod: 'GET',
      url: 'https://www.googleapis.com/drive/v3/files',
      parameters: [
        { name: 'q', in: 'query', required: false, type: 'string' },
        { name: 'pageSize', in: 'query', required: false, type: 'integer' },
      ],
      hasBody: false,
    },
    {
      id: 'drive.files.copy',
      httpMethod: 'POST',
      url: 'https://www.googleapis.com/drive/v3/files/{fileId}/copy',
      parameters: [{ name: 'fileId', in: 'path', required: true, type: 'string' }],
      hasBody: true,
    },
  ],
};

function driveIndex(): ConnectorOpIndex {
  const op = (method: string, path: string, params: string[]) => ({
    method,
    path,
    summary: '',
    parameters: params.map((name) => ({ name, in: 'path' as const, required: true, type: 'string' })),
  });
  return {
    connectorId: 'shared_googledrive',
    displayName: 'Google Drive',
    proxyHost: 'x',
    proxyBasePath: '/',
    securityDefinitions: {},
    connectionAuth: {},
    operationCount: 4,
    operations: {
      GetFileMetadata: op('GET', '/{connectionId}/datasets/default/files/{id}', ['id']),
      GetFileContent: op('GET', '/{connectionId}/datasets/default/files/{id}/content', ['id']),
      ListFolder: op('GET', '/{connectionId}/datasets/default/foldersV2/{folderId}', ['folderId']),
      CopyFile: op('POST', '/{connectionId}/datasets/default/copyFile', ['id', 'destination']),
    },
  };
}

function entry(over: Partial<OperationMapEntry> = {}): OperationMapEntry {
  return {
    connectorId: 'shared_googledrive',
    operationId: 'GetFileMetadata',
    api: 'drive',
    provenance: 'drafted',
    steps: [{
      vendorMethodId: 'drive.files.get',
      parameters: [{ to: 'fileId', in: 'path', template: '{id}' }],
    }],
    ...over,
  };
}

const index = driveIndex();
const verify = (e: OperationMapEntry) => verifyMapEntry(e, DRIVE, index);

/** The `kind`s reported, for terse assertions. */
function kinds(r: ReturnType<typeof verify>): string[] {
  return r.status === 'rejected' ? r.problems.map((p) => p.kind) : [];
}

describe('verifyMapEntry — accepts a correct mapping', () => {
  it('passes a 1:1 rename where every required parameter is filled', () => {
    const r = verify(entry());
    expect(r.status).toBe('verified');
    if (r.status === 'verified') {
      expect(r.checks[0]).toContain('https://www.googleapis.com/drive/v3/files/{fileId}');
    }
  });

  it('accepts a query EXPRESSION built from a source argument', () => {
    // The mapping that motivates templates over renames: Drive has no "list this folder",
    // it has a search language. `{folderId}` is interpolated INTO a larger string.
    const r = verify(entry({
      operationId: 'ListFolder',
      steps: [{
        vendorMethodId: 'drive.files.list',
        parameters: [{ to: 'q', in: 'query', template: "'{folderId}' in parents" }],
      }],
    }));
    expect(r.status).toBe('verified');
  });

  it('accepts an API-wide parameter the method itself does not declare', () => {
    // `alt=media` is how Drive returns bytes instead of metadata. It lives in Discovery's
    // top-level block, so a verifier that only read method parameters would call this
    // correct mapping invented.
    const r = verify(entry({
      operationId: 'GetFileContent',
      steps: [{
        vendorMethodId: 'drive.files.get',
        parameters: [
          { to: 'fileId', in: 'path', template: '{id}' },
          { to: 'alt', in: 'query', template: 'media' },
        ],
      }],
    }));
    expect(r.status).toBe('verified');
  });
});

describe('verifyMapEntry — refuses an entry that is wrong but plausible', () => {
  it('rejects a vendor method that does not exist', () => {
    // The most likely drafting error: a method id that follows the vendor's naming
    // convention perfectly and is simply not published.
    const r = verify(entry({
      steps: [{ vendorMethodId: 'drive.files.fetch', parameters: [] }],
    }));
    expect(kinds(r)).toContain('unknown-vendor-method');
  });

  it('rejects a parameter the vendor does not declare', () => {
    const r = verify(entry({
      steps: [{
        vendorMethodId: 'drive.files.get',
        parameters: [
          { to: 'fileId', in: 'path', template: '{id}' },
          { to: 'includePermissions', in: 'query', template: 'true' },
        ],
      }],
    }));
    expect(kinds(r)).toContain('undeclared-parameter');
  });

  it('rejects an entry that leaves a REQUIRED vendor parameter unfilled', () => {
    // Fails at run time with a 400 rather than wrong data, but it fails on every call, so
    // catching it offline is the difference between a bad migration and a bad entry.
    const r = verify(entry({
      steps: [{ vendorMethodId: 'drive.files.get', parameters: [] }],
    }));
    expect(kinds(r)).toContain('missing-required-parameter');
  });

  it('rejects interpolating an argument the source operation does not have', () => {
    // The dangerous one: `{fileId}` reads correctly to a human, but the Power Platform
    // operation calls it `id`, so the template would interpolate nothing and the call would
    // be made against an empty string.
    const r = verify(entry({
      steps: [{
        vendorMethodId: 'drive.files.get',
        parameters: [{ to: 'fileId', in: 'path', template: '{fileId}' }],
      }],
    }));
    expect(kinds(r)).toContain('unknown-source-argument');
  });

  it('rejects a literal outside the vendor\'s declared enum', () => {
    const r = verify(entry({
      steps: [{
        vendorMethodId: 'drive.files.get',
        parameters: [
          { to: 'fileId', in: 'path', template: '{id}' },
          { to: 'alt', in: 'query', template: 'raw' },
        ],
      }],
    }));
    expect(kinds(r)).toContain('enum-violation');
  });

  it('rejects a body sent to a method that declares none', () => {
    const r = verify(entry({
      steps: [{
        vendorMethodId: 'drive.files.get',
        parameters: [
          { to: 'fileId', in: 'path', template: '{id}' },
          { to: 'name', in: 'body', template: '{id}' },
        ],
      }],
    }));
    expect(kinds(r)).toContain('body-not-supported');
  });

  it('rejects an entry verified against the wrong API', () => {
    const r = verify(entry({ api: 'sheets' }));
    expect(kinds(r)).toEqual(['api-mismatch']);
  });
});

describe('verifyMapEntry — URL placeholders, not just declared names', () => {
  // Discovery's flatPath renames as it spells out the templated path: People declares a
  // parameter `resourceName` and writes the URL as `v1/people/{peopleId}/connections`.
  // Checking declared names alone rejects the one correct mapping; checking them alone the
  // other way accepts a URL shipped with a hole in it.
  const PEOPLE: VendorApiSurface = {
    api: 'people',
    schemaVersion: 2,
    methods: [{
      id: 'people.people.connections.list',
      httpMethod: 'GET',
      url: 'https://people.googleapis.com/v1/people/{peopleId}/connections',
      parameters: [
        { name: 'resourceName', in: 'path', required: true, type: 'string' },
        { name: 'personFields', in: 'query', required: false, type: 'string' },
      ],
      hasBody: false,
    }],
  };
  const peopleEntry = (params: OperationMapEntry['steps'][number]['parameters']): OperationMapEntry => ({
    connectorId: 'shared_googlecontacts', operationId: 'GetFileMetadata', api: 'people',
    provenance: 'drafted', steps: [{ vendorMethodId: 'people.people.connections.list', parameters: params }],
  });

  it('accepts a path value addressed by the URL placeholder', () => {
    const r = verifyMapEntry(peopleEntry([
      { to: 'peopleId', in: 'path', template: 'me' },
      { to: 'personFields', in: 'query', template: 'names' },
    ]), PEOPLE, index);
    expect(r.status).toBe('verified');
  });

  it('rejects an entry that leaves a URL placeholder unfilled', () => {
    // Fails on every single call, so catching it offline is the whole point.
    const r = verifyMapEntry(peopleEntry([
      { to: 'personFields', in: 'query', template: 'names' },
    ]), PEOPLE, index);
    expect(kinds(r)).toContain('missing-required-parameter');
  });
});

describe('verifyMapEntry — multi-step recipes', () => {
  const byPath: OperationMapEntry = {
    connectorId: 'shared_googledrive',
    operationId: 'GetFileContent',
    api: 'drive',
    provenance: 'drafted',
    notes: ['Drive v3 has no path lookup; resolved by name search then fetch.'],
    steps: [
      {
        vendorMethodId: 'drive.files.list',
        parameters: [{ to: 'q', in: 'query', template: "name = '{id}'" }],
        capture: { fid: 'files[0].id' },
      },
      {
        vendorMethodId: 'drive.files.get',
        parameters: [
          { to: 'fileId', in: 'path', template: '{$fid}' },
          { to: 'alt', in: 'query', template: 'media' },
        ],
      },
    ],
  };

  it('accepts a later step consuming what an earlier step captured', () => {
    expect(verify(byPath).status).toBe('verified');
  });

  it('rejects a FORWARD reference to a variable captured later', () => {
    // Steps run in order, so a step may only read what already happened. Reversed, the
    // first step interpolates a variable that does not exist yet.
    const reversed: OperationMapEntry = { ...byPath, steps: [byPath.steps[1], byPath.steps[0]] };
    expect(kinds(verify(reversed))).toContain('unknown-captured-variable');
  });
});

describe('verifyMapEntry — refuses to guess when it cannot check', () => {
  it('says cannot-verify when the cached surface predates parameter capture', () => {
    // An old Mongo row returns `parameters: undefined`. Treating that as "declares none"
    // would reject every correct entry; reporting it as a rejection would blame the entry
    // for the cache.
    const old: VendorApiSurface = {
      api: 'drive',
      methods: [{ id: 'drive.files.get', httpMethod: 'GET', url: 'https://x/files/{fileId}' }],
    };
    const r = verifyMapEntry(entry(), old, index);
    expect(r.status).toBe('cannot-verify');
  });

  it('says cannot-verify when the connector does not declare the operation here', () => {
    // A customer on an older connector version genuinely does not have it. That is not a
    // bad entry, and must not be reported as one.
    const r = verify(entry({ operationId: 'ExtractFolderV3' }));
    expect(r.status).toBe('cannot-verify');
  });
});

describe('operation map lookup', () => {
  it('lets a later entry override an earlier one for the same operation', () => {
    const map = indexOperationMap([
      entry({ provenance: 'drafted' }),
      entry({ provenance: 'behaviorally-verified' }),
    ]);
    expect(lookupMapEntry(map, 'shared_googledrive', 'GetFileMetadata')?.provenance)
      .toBe('behaviorally-verified');
  });

  it('returns nothing for an unmapped operation rather than a near match', () => {
    const map = indexOperationMap([entry()]);
    expect(lookupMapEntry(map, 'shared_googledrive', 'DeleteFile')).toBeUndefined();
  });
});

describe('verifyMapEntry — body templates', () => {
  const copy = (bodyTemplate: string): OperationMapEntry => ({
    connectorId: 'shared_googledrive', operationId: 'CopyFile', api: 'drive', provenance: 'drafted',
    steps: [{
      vendorMethodId: 'drive.files.copy',
      parameters: [{ to: 'fileId', in: 'path', template: '{id}' }],
      bodyTemplate,
    }],
  });

  it('accepts a template whose placeholders sit in value position', () => {
    // Unquoted on purpose: the placeholder is replaced by the JSON ENCODING of the argument,
    // so a string destination arrives as ["abc"] rather than [abc].
    expect(verify(copy('{"parents": [{destination}]}')).status).toBe('verified');
  });

  it('rejects a template that is not valid JSON once filled', () => {
    expect(kinds(verify(copy('{"parents": [{destination}]'))).includes('malformed-body-template')).toBe(true);
  });

  it('rejects a body placeholder that is not an argument of the operation', () => {
    expect(kinds(verify(copy('{"parents": [{folderId}]}'))).includes('unknown-source-argument')).toBe(true);
  });

  it('rejects a body sent to a method that declares none', () => {
    const noBody: OperationMapEntry = {
      connectorId: 'shared_googledrive', operationId: 'GetFileMetadata', api: 'drive', provenance: 'drafted',
      steps: [{
        vendorMethodId: 'drive.files.get',
        parameters: [{ to: 'fileId', in: 'path', template: '{id}' }],
        bodyTemplate: '{"x": 1}',
      }],
    };
    expect(kinds(verify(noBody)).includes('body-not-supported')).toBe(true);
  });
});
