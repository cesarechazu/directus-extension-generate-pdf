import test from 'node:test';
import assert from 'node:assert/strict';
import operation from '../src/api.js';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XWZ0AAAAASUVORK5CYII=';
const PNG_BUFFER = Buffer.from(PNG_BASE64, 'base64');

function createFetchMock() {
  const calls = [];

  const mock = async (url) => {
    calls.push(String(url));
    return new Response(PNG_BUFFER, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(PNG_BUFFER.length),
      },
    });
  };

  return { mock, calls };
}

function createContext(overrides = {}) {
  const uploads = [];

  class MockFilesService {
    async uploadOne(stream, payload) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      uploads.push({
        payload,
        bytes: Buffer.concat(chunks).length,
      });
      return 'mock-file-id';
    }
  }

  const context = {
    services: {
      FilesService: MockFilesService,
    },
    database: {},
    getSchema: async () => ({}),
    accountability: null,
    logger: {
      info() {},
    },
    env: {
      PUBLIC_URL: 'https://midirectus.com/admin',
    },
    ...overrides,
  };

  return { context, uploads };
}

function baseOptions(overrides = {}) {
  return {
    template: {
      basePdf: { width: 210, height: 297, padding: [10, 10, 10, 10] },
      schemas: [
        [
          {
            name: 'title',
            type: 'text',
            position: { x: 20, y: 20 },
            width: 100,
            height: 12,
            fontSize: 18,
          },
          {
            name: 'user.first_name',
            type: 'text',
            position: { x: 20, y: 36 },
            width: 100,
            height: 10,
            fontSize: 10,
          },
          {
            name: 'ean_code',
            type: 'ean13',
            position: { x: 20, y: 52 },
            width: 60,
            height: 18,
            content: '2112345678900',
            backgroundColor: '#FFFFFF',
            barColor: '#111827',
            textColor: '#111827',
            includetext: true,
          },
        ],
      ],
    },
    inputs: {
      title: 'Hello',
      user: { first_name: 'Ada' },
      ean_code: '2112345678900',
    },
    filename: 'Invoice.PDF',
    storage: 'local',
    store_file: false,
    ...overrides,
  };
}

test('generates a PDF, preserves filename casing, and enriches response metadata', async () => {
  const { context } = createContext();
  const result = await operation.handler(baseOptions(), context);

  assert.equal(result.filename, 'Invoice.PDF');
  assert.equal(result.title, 'Invoice.PDF');
  assert.equal(result.storage, 'local');
  assert.equal(result.stored, false);
  assert.equal(result.asset_url, null);
  assert.equal(result.file_id, null);
  assert.ok(result.bytes > 0);
  assert.equal(result.pages, 1);
});

test('stores the generated PDF and returns asset metadata', async () => {
  const { context, uploads } = createContext();
  const result = await operation.handler(
    baseOptions({
      store_file: true,
      title: 'Invoice 001',
      folder: 'folder-123',
    }),
    context
  );

  assert.equal(result.file_id, 'mock-file-id');
  assert.equal(result.title, 'Invoice 001');
  assert.equal(result.folder, 'folder-123');
  assert.equal(result.asset_url, 'https://midirectus.com/assets/mock-file-id');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].payload.title, 'Invoice 001');
  assert.equal(uploads[0].payload.folder, 'folder-123');
  assert.ok(uploads[0].bytes > 0);
});

test('supports background_image from a Directus file id', async () => {
  const { context } = createContext();
  const { mock, calls } = createFetchMock();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;

  try {
    const result = await operation.handler(
      baseOptions({
        background_image: 'abc123',
      }),
      context
    );

    assert.ok(result.bytes > 0);
    assert.deepEqual(calls, ['https://midirectus.com/assets/abc123']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('warns and recovers from an invalid Roboto-Bold font config', async () => {
  const { context } = createContext();
  const result = await operation.handler(
    baseOptions({
      template: {
        basePdf: { width: 210, height: 297, padding: [10, 10, 10, 10] },
        schemas: [
          [
            {
              name: 'title',
              type: 'text',
              position: { x: 20, y: 20 },
              width: 100,
              height: 12,
              fontSize: 18,
              fontName: 'Roboto-Bold',
            },
          ],
        ],
      },
      inputs: { title: 'Hello' },
      generate_options: {
        font: {
          'Roboto-Bold': {},
        },
      },
    }),
    context
  );

  assert.ok(result.warnings.some((warning) => warning.includes('Invalid Roboto-Bold font configuration')));
  assert.ok(result.bytes > 0);
});

test('rejects invalid template JSON strings with a clear error', async () => {
  const { context } = createContext();

  await assert.rejects(
    () =>
      operation.handler(
        {
          ...baseOptions(),
          template: '{',
        },
        context
      ),
    /template must be valid JSON/
  );
});

test('rejects background images hosted on other domains', async () => {
  const { context } = createContext();

  await assert.rejects(
    () =>
      operation.handler(
        baseOptions({
          background_image: 'https://example.com/assets/abc123',
        }),
        context
      ),
    /must use the same host as Directus PUBLIC_URL/
  );
});

test('rejects invalid generate_options shapes before rendering', async () => {
  const { context } = createContext();

  await assert.rejects(
    () =>
      operation.handler(
        baseOptions({
          generate_options: [],
        }),
        context
      ),
    /generate_options must be an object/
  );
});
