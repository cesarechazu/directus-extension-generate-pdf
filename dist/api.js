import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '@pdfme/generator';
import { checkFont, checkInputs, checkTemplate, getDefaultFont } from '@pdfme/common';
import {
  text,
  multiVariableText,
  image,
  svg,
  table,
  barcodes,
  line,
  rectangle,
  ellipse,
  dateTime,
  date,
  time,
  select,
  radioGroup,
  checkbox,
} from '@pdfme/schemas';

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROBOTO_BOLD_FILES = [
  path.join(EXTENSION_DIR, 'fonts', 'Roboto-Bold.ttf'),
  path.join(EXTENSION_DIR, 'fonts', 'Roboto-Bold.otf'),
  path.join(EXTENSION_DIR, 'fonts', 'Roboto-Bold.woff'),
  path.join(EXTENSION_DIR, 'fonts', 'Roboto-Bold.woff2'),
  path.join(EXTENSION_DIR, '..', 'fonts', 'Roboto-Bold.ttf'),
  path.join(EXTENSION_DIR, '..', 'fonts', 'Roboto-Bold.otf'),
  path.join(EXTENSION_DIR, '..', 'fonts', 'Roboto-Bold.woff'),
  path.join(EXTENSION_DIR, '..', 'fonts', 'Roboto-Bold.woff2'),
];
const REMOTE_IMAGE_TIMEOUT_MS = 10_000;
const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
const DIRECTUS_ASSETS_PREFIX = '/assets/';
const ALLOWED_BACKGROUND_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);

function parseMaybeJSON(value, fieldName) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`${fieldName} must be valid JSON when provided as string`);
    }
  }
  if (typeof value === 'object') return value;
  throw new Error(`${fieldName} must be an object, array, or JSON string`);
}

function sanitizeFilename(name) {
  const safe = String(name || 'document.pdf').replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').trim();
  if (!safe) return 'document.pdf';
  return /\.pdf$/i.test(safe) ? safe : `${safe}.pdf`;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeMimeType(value) {
  const mimeType = normalizeOptionalString(value).toLowerCase();
  if (mimeType === 'image/jpg') return 'image/jpeg';
  return mimeType;
}

function getDirectusPublicOrigin(env) {
  const publicUrl = normalizeOptionalString(env?.PUBLIC_URL);
  if (!publicUrl) return null;

  try {
    return new URL(publicUrl).origin;
  } catch {
    return null;
  }
}

function parseAllowedAssetUrl(rawUrl, { label, publicOrigin }) {
  const value = normalizeOptionalString(rawUrl);
  if (!value) return null;

  if (value.startsWith('/') && !publicOrigin) {
    throw new Error(`${label} URL requires Directus PUBLIC_URL to be configured`);
  }

  let parsedUrl;
  try {
    parsedUrl = value.startsWith('/') ? new URL(value, publicOrigin) : new URL(value);
  } catch {
    throw new Error(`${label} URL is invalid`);
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error(`${label} URL must use http or https`);
  }

  if (!publicOrigin) {
    throw new Error(`${label} URL requires Directus PUBLIC_URL to be configured`);
  }

  if (parsedUrl.origin !== publicOrigin) {
    throw new Error(`${label} URL must use the same host as Directus PUBLIC_URL`);
  }

  if (!parsedUrl.pathname.startsWith(DIRECTUS_ASSETS_PREFIX) || parsedUrl.pathname.length <= DIRECTUS_ASSETS_PREFIX.length) {
    throw new Error(`${label} URL must point to ${DIRECTUS_ASSETS_PREFIX}<file_id> on the same Directus host`);
  }

  return parsedUrl;
}

function assertAllowedBackgroundMimeType(mimeType, label) {
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (!normalizedMimeType || !ALLOWED_BACKGROUND_MIME_TYPES.has(normalizedMimeType)) {
    throw new Error(
      `${label} must be one of: ${Array.from(ALLOWED_BACKGROUND_MIME_TYPES)
        .map((type) => type.replace('image/', ''))
        .join(', ')}`
    );
  }

  return normalizedMimeType;
}

function detectSupportedImageMimeType(buffer) {
  if (!buffer || buffer.length < 4) return null;

  const isPng =
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
  if (isPng) return 'image/png';

  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (isJpeg) return 'image/jpeg';

  const header6 = buffer.subarray(0, 6).toString('ascii');
  if (header6 === 'GIF87a' || header6 === 'GIF89a') return 'image/gif';

  const riff = buffer.subarray(0, 4).toString('ascii');
  const webp = buffer.length >= 12 && buffer.subarray(8, 12).toString('ascii');
  if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';

  return null;
}

function validateImageBuffer({ buffer, label, declaredMimeType }) {
  if (!buffer || buffer.length === 0) {
    throw new Error(`${label} returned an empty file`);
  }

  if (buffer.length > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_REMOTE_IMAGE_BYTES} byte size limit`);
  }

  const detectedMimeType = detectSupportedImageMimeType(buffer);
  if (!detectedMimeType) {
    throw new Error(`${label} must be a supported PNG, JPEG, WEBP, or GIF image`);
  }

  const normalizedDeclaredMimeType = declaredMimeType ? assertAllowedBackgroundMimeType(declaredMimeType, label) : null;
  if (normalizedDeclaredMimeType && normalizedDeclaredMimeType !== detectedMimeType) {
    throw new Error(`${label} content does not match the declared MIME type`);
  }

  return detectedMimeType;
}

function parseDataImageUrl(value, label) {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return null;

  const [, mimeType, base64Data] = match;
  const normalizedMimeType = assertAllowedBackgroundMimeType(mimeType, label);

  let buffer;
  try {
    buffer = Buffer.from(base64Data, 'base64');
  } catch {
    throw new Error(`${label} data URL is invalid`);
  }

  const detectedMimeType = validateImageBuffer({
    buffer,
    label,
    declaredMimeType: normalizedMimeType,
  });

  return `data:${detectedMimeType};base64,${buffer.toString('base64')}`;
}

function looksLikeUrl(value) {
  return value.startsWith('/') || value.startsWith('http://') || value.startsWith('https://');
}

function resolveBackgroundImageSource(rawValue, { label, publicOrigin }) {
  const value = normalizeOptionalString(rawValue);
  if (!value) return null;

  const inlineDataUrl = parseDataImageUrl(value, label);
  if (inlineDataUrl) return { kind: 'data', value: inlineDataUrl };
  if (value.startsWith('data:')) {
    throw new Error(`${label} data URL must use the format data:image/<type>;base64,...`);
  }

  if (looksLikeUrl(value)) {
    return { kind: 'url', value: parseAllowedAssetUrl(value, { label, publicOrigin }).toString() };
  }

  if (!publicOrigin) {
    throw new Error(`${label} file ID requires Directus PUBLIC_URL to be configured`);
  }

  return {
    kind: 'file_id',
    value: new URL(`${DIRECTUS_ASSETS_PREFIX}${encodeURIComponent(value)}`, publicOrigin).toString(),
  };
}

async function resolveBackgroundImageDataUrl({ value, label, publicOrigin }) {
  const resolvedSource = resolveBackgroundImageSource(value, { label, publicOrigin });
  if (!resolvedSource) return null;

  if (resolvedSource.kind === 'data') {
    return resolvedSource.value;
  }

  const parsedUrl = new URL(resolvedSource.value);

  let response;
  try {
    response = await fetch(parsedUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS),
    });
  } catch (error) {
    const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    const suffix = isTimeout ? `timed out after ${REMOTE_IMAGE_TIMEOUT_MS}ms` : error instanceof Error ? error.message : 'unknown error';
    throw new Error(`Failed to fetch ${label} URL: ${suffix}`);
  }

  parseAllowedAssetUrl(response.url || parsedUrl.toString(), { label, publicOrigin });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${label} URL: HTTP ${response.status}`);
  }

  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
  if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error(`${label} URL exceeds the ${MAX_REMOTE_IMAGE_BYTES} byte size limit`);
  }

  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
  const imageBuffer = Buffer.from(await response.arrayBuffer());
  const mimeType = validateImageBuffer({
    buffer: imageBuffer,
    label: `${label} URL`,
    declaredMimeType: contentType || undefined,
  });

  return `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
}

function migrateLegacySchemas(schemas) {
  if (!Array.isArray(schemas)) return [[]];
  if (schemas.length === 0) return [[]];
  if (Array.isArray(schemas[0])) return schemas;

  return schemas.map((page, pageIndex) => {
    if (!page || typeof page !== 'object') return [];
    return Object.entries(page).map(([name, schema], schemaIndex) => {
      const objectSchema = schema && typeof schema === 'object' ? schema : {};
      return {
        ...objectSchema,
        name: objectSchema.name || name || `field_${pageIndex}_${schemaIndex}`,
      };
    });
  });
}

function ensureTemplate(templateValue) {
  if (templateValue !== undefined && (!templateValue || typeof templateValue !== 'object' || Array.isArray(templateValue))) {
    throw new Error('template must be an object or empty');
  }

  const template = templateValue && typeof templateValue === 'object' ? structuredClone(templateValue) : {};
  template.schemas = migrateLegacySchemas(template.schemas);

  if (!template.basePdf) {
    template.basePdf = {
      width: 210,
      height: 297,
      padding: [10, 10, 10, 10],
    };
  }

  return template;
}

function validateTemplate(template) {
  try {
    checkTemplate(template);
  } catch (error) {
    throw new Error(`template is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateInputs(inputs) {
  try {
    checkInputs(inputs);
  } catch (error) {
    throw new Error(`inputs are invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateGenerateOptions(generateOptions) {
  if (!generateOptions || typeof generateOptions !== 'object' || Array.isArray(generateOptions)) {
    throw new Error('generate_options must be an object when provided');
  }

  if (generateOptions.font !== undefined) {
    if (!generateOptions.font || typeof generateOptions.font !== 'object' || Array.isArray(generateOptions.font)) {
      throw new Error('generate_options.font must be an object when provided');
    }
  }
}

function validateResolvedGenerateOptions(generateOptions, template) {
  if (!generateOptions?.font) return;

  try {
    checkFont({ font: generateOptions.font, template });
  } catch (error) {
    throw new Error(`generate_options.font is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeSchemasForCompatibility(template, warnings) {
  if (!Array.isArray(template.schemas)) return;

  template.schemas = template.schemas.map((page, pageIndex) => {
    if (!Array.isArray(page)) return [];

    return page.map((schema, schemaIndex) => {
      if (!schema || typeof schema !== 'object') return schema;

      if (schema.type !== 'multiVariableText') return schema;

      const hasMvtShape = typeof schema.text === 'string' || Array.isArray(schema.variables);
      if (hasMvtShape) return schema;

      warnings.push(
        `Schema "${schema.name || `field_${pageIndex}_${schemaIndex}`}" used multiVariableText without variables/text; converted to text`
      );

      const converted = { ...schema, type: 'text' };
      if (typeof converted.content !== 'string' && typeof converted.text === 'string') {
        converted.content = converted.text;
      }
      delete converted.text;
      delete converted.variables;
      return converted;
    });
  });
}

function templateUsesFont(template, targetFontName) {
  if (!Array.isArray(template?.schemas)) return false;

  for (const page of template.schemas) {
    if (!Array.isArray(page)) continue;
    for (const schema of page) {
      if (!schema || typeof schema !== 'object') continue;
      if (schema.fontName === targetFontName) return true;

      if (schema.type === 'table') {
        if (schema?.headStyles?.fontName === targetFontName) return true;
        if (schema?.bodyStyles?.fontName === targetFontName) return true;
        if (schema.columnStyles && typeof schema.columnStyles === 'object') {
          for (const styleGroup of Object.values(schema.columnStyles)) {
            if (!styleGroup || typeof styleGroup !== 'object') continue;
            for (const style of Object.values(styleGroup)) {
              if (style && typeof style === 'object' && style.fontName === targetFontName) return true;
            }
          }
        }
      }
    }
  }

  return false;
}

function getFontMimeByPath(fontPath) {
  const lower = fontPath.toLowerCase();
  if (lower.endsWith('.otf')) return 'font/otf';
  if (lower.endsWith('.woff')) return 'font/woff';
  if (lower.endsWith('.woff2')) return 'font/woff2';
  return 'font/ttf';
}

async function loadLocalFontDataUrl(fontPaths) {
  for (const fontPath of fontPaths) {
    try {
      const bytes = await readFile(fontPath);
      if (!bytes || bytes.length < 1024) continue;
      const mimeType = getFontMimeByPath(fontPath);
      return {
        dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
        filePath: fontPath,
      };
    } catch {
      // Try next candidate
    }
  }
  return null;
}

async function ensureBuiltinRobotoBoldFont(generateOptions, warnings) {
  const options = generateOptions && typeof generateOptions === 'object' ? generateOptions : {};
  const mergedOptions = { ...options };
  const userFont = options.font && typeof options.font === 'object' ? options.font : {};
  const mergedFont = { ...userFont };

  // Ensure fallback font is available and marked as fallback.
  const hasFallback = Object.values(mergedFont).some((fontValue) => fontValue && typeof fontValue === 'object' && fontValue.fallback === true);
  if (!hasFallback) {
    const defaultFont = getDefaultFont();
    if (!mergedFont.Roboto) {
      mergedFont.Roboto = defaultFont.Roboto;
    } else if (mergedFont.Roboto && typeof mergedFont.Roboto === 'object') {
      mergedFont.Roboto = { ...mergedFont.Roboto, fallback: true };
    }
  }

  let hasLocalRobotoBold = false;
  const existingRobotoBold = mergedFont['Roboto-Bold'];
  const hasUsableExistingRobotoBold =
    existingRobotoBold &&
    typeof existingRobotoBold === 'object' &&
    typeof existingRobotoBold.data === 'string' &&
    existingRobotoBold.data.trim().length > 0;

  // Register Roboto-Bold from local file if not provided by user.
  if (!hasUsableExistingRobotoBold) {
    if (mergedFont['Roboto-Bold']) {
      delete mergedFont['Roboto-Bold'];
      warnings.push('Invalid Roboto-Bold font configuration detected. Replaced with local/default font behavior.');
    }
    const localFont = await loadLocalFontDataUrl(ROBOTO_BOLD_FILES);
    if (localFont) {
      mergedFont['Roboto-Bold'] = { data: localFont.dataUrl };
      hasLocalRobotoBold = true;
    }
  } else {
    hasLocalRobotoBold = true;
  }

  mergedOptions.font = mergedFont;
  return { generateOptions: mergedOptions, hasLocalRobotoBold };
}

function replaceFontName(template, fromName, toName) {
  if (!Array.isArray(template?.schemas)) return;

  for (const page of template.schemas) {
    if (!Array.isArray(page)) continue;
    for (const schema of page) {
      if (!schema || typeof schema !== 'object') continue;
      if (schema.fontName === fromName) schema.fontName = toName;

      if (schema.type === 'table') {
        if (schema?.headStyles?.fontName === fromName) schema.headStyles.fontName = toName;
        if (schema?.bodyStyles?.fontName === fromName) schema.bodyStyles.fontName = toName;
        if (schema.columnStyles && typeof schema.columnStyles === 'object') {
          for (const styleGroup of Object.values(schema.columnStyles)) {
            if (!styleGroup || typeof styleGroup !== 'object') continue;
            for (const style of Object.values(styleGroup)) {
              if (style && typeof style === 'object' && style.fontName === fromName) {
                style.fontName = toName;
              }
            }
          }
        }
      }
    }
  }
}

function normalizeInputs(inputsValue) {
  if (inputsValue === undefined) return [{}];
  if (Array.isArray(inputsValue)) {
    if (inputsValue.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new Error('inputs array must contain only objects');
    }
    return inputsValue;
  }
  if (inputsValue && typeof inputsValue === 'object') return [inputsValue];
  throw new Error('inputs must be an object, array of objects, or empty');
}

function getTemplateFieldNames(template) {
  const names = new Set();
  if (!Array.isArray(template?.schemas)) return names;

  for (const page of template.schemas) {
    if (!Array.isArray(page)) continue;
    for (const schema of page) {
      if (!schema || typeof schema !== 'object') continue;
      if (typeof schema.name === 'string' && schema.name.trim()) {
        names.add(schema.name.trim());
      }
    }
  }

  return names;
}

function getValueByDotPath(source, dotPath) {
  if (!source || typeof source !== 'object') return undefined;
  const segments = dotPath.split('.').filter(Boolean);
  if (segments.length === 0) return undefined;

  let current = source;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;

    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }

    if (typeof current !== 'object') return undefined;
    current = current[segment];
  }

  return current;
}

function enrichInputsWithDotNotation(template, inputs) {
  const templateFieldNames = getTemplateFieldNames(template);
  if (templateFieldNames.size === 0) return inputs;

  return inputs.map((input) => {
    const enriched = { ...input };

    for (const fieldName of templateFieldNames) {
      if (!fieldName.includes('.')) continue;
      if (Object.prototype.hasOwnProperty.call(enriched, fieldName)) continue;

      const nestedValue = getValueByDotPath(input, fieldName);
      if (nestedValue !== undefined) {
        enriched[fieldName] = nestedValue;
      }
    }

    return enriched;
  });
}

function getPlugins() {
  return {
    text,
    multiVariableText,
    image,
    svg,
    table,
    line,
    rectangle,
    ellipse,
    dateTime,
    date,
    time,
    select,
    radioGroup,
    checkbox,
    ...barcodes,
  };
}

export default {
  id: 'generate-pdf-operation',
  handler: async (options, context) => {
    const { services, database, getSchema, accountability, logger, env } = context;
    const warnings = [];

    const templateOption = parseMaybeJSON(options.template, 'template');
    const inputsOption = parseMaybeJSON(options.inputs, 'inputs');
    let generateOptions = parseMaybeJSON(options.generate_options, 'generate_options') || {};
    const template = ensureTemplate(templateOption);
    const inputs = enrichInputsWithDotNotation(template, normalizeInputs(inputsOption));
    validateTemplate(template);
    validateInputs(inputs);
    validateGenerateOptions(generateOptions);
    normalizeSchemasForCompatibility(template, warnings);
    const usesRobotoBold = templateUsesFont(template, 'Roboto-Bold');
    const robotoBoldConfig = await ensureBuiltinRobotoBoldFont(generateOptions, warnings);
    const directusPublicOrigin = getDirectusPublicOrigin(env);
    generateOptions = robotoBoldConfig.generateOptions;
    validateResolvedGenerateOptions(generateOptions, template);

    if (usesRobotoBold && !robotoBoldConfig.hasLocalRobotoBold) {
      replaceFontName(template, 'Roboto-Bold', 'Roboto');
      warnings.push('Roboto-Bold.ttf was not found in extension fonts folder. Replaced with Roboto.');
    }

    const backgroundDataUrl = await resolveBackgroundImageDataUrl({
      value: options.background_image,
      label: 'background_image',
      publicOrigin: directusPublicOrigin,
    });

    if (backgroundDataUrl) {
      if (typeof template.basePdf !== 'object') {
        warnings.push('background was ignored because base PDF is not a blank template object');
      } else {
        const pageWidth = Number(template.basePdf.width) || 210;
        const pageHeight = Number(template.basePdf.height) || 297;
        const staticSchema = Array.isArray(template.basePdf.staticSchema) ? [...template.basePdf.staticSchema] : [];
        const withoutOldBackground = staticSchema.filter((schema) => schema?.name !== 'background_image');
        withoutOldBackground.unshift({
          name: 'background_image',
          type: 'image',
          position: { x: 0, y: 0 },
          width: pageWidth,
          height: pageHeight,
          content: backgroundDataUrl,
          readOnly: false,
        });
        template.basePdf.staticSchema = withoutOldBackground;
      }
    }

    let pdfBytes;
    try {
      pdfBytes = await generate({
        template,
        inputs,
        options: generateOptions,
        plugins: getPlugins(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hasRobotoBoldConfigured = !!(generateOptions?.font && typeof generateOptions.font === 'object' && generateOptions.font['Roboto-Bold']);
      const stackText = error instanceof Error ? String(error.stack || '') : '';
      const causeText = error && typeof error === 'object' && 'cause' in error ? String(error.cause || '') : '';
      const isRobotoBoldLoadError =
        message.includes('raw.githubusercontent.com') ||
        message.includes('Roboto-Bold') ||
        message.includes('Unknown font format') ||
        stackText.includes('raw.githubusercontent.com') ||
        stackText.includes('Unknown font format') ||
        causeText.includes('raw.githubusercontent.com') ||
        causeText.includes('Unknown font format') ||
        (hasRobotoBoldConfigured && message.includes('fetch failed'));
      if (!isRobotoBoldLoadError) throw error;

      replaceFontName(template, 'Roboto-Bold', 'Roboto');
      warnings.push('Roboto-Bold could not be loaded. Retried with Roboto (regular).');

      if (generateOptions?.font && typeof generateOptions.font === 'object') {
        const retryFont = { ...generateOptions.font };
        delete retryFont['Roboto-Bold'];
        generateOptions = { ...generateOptions, font: retryFont };
      }

      pdfBytes = await generate({
        template,
        inputs,
        options: generateOptions,
        plugins: getPlugins(),
      });
    }

    const pdfBuffer = Buffer.from(pdfBytes);
    const filename = sanitizeFilename(options.filename || 'document.pdf');
    const storage = String(options.storage || 'local');
    const saveToFiles = options.store_file !== false;
    const returnBase64 = options.return_base64 === true;
    const title = options.title || filename;

    let fileId = null;

    if (saveToFiles) {
      const schema = await getSchema({ database });
      const filesService = new services.FilesService({
        knex: database,
        schema,
        accountability,
      });

      const payload = {
        storage,
        type: 'application/pdf',
        filename_download: filename,
        title,
      };

      if (options.folder) payload.folder = String(options.folder);
      fileId = await filesService.uploadOne(Readable.from(pdfBuffer), payload);
    }

    logger.info(
      {
        extension: 'generate-pdf-operation',
        bytes: pdfBuffer.length,
        saved: saveToFiles,
        fileId,
        warnings,
      },
      'PDF generated'
    );

    return {
      file_id: fileId,
      filename,
      title,
      storage,
      stored: saveToFiles,
      folder: options.folder ? String(options.folder) : null,
      mime_type: 'application/pdf',
      bytes: pdfBuffer.length,
      pages: inputs.length,
      warnings,
      asset_url: fileId && directusPublicOrigin ? new URL(`${DIRECTUS_ASSETS_PREFIX}${fileId}`, directusPublicOrigin).toString() : null,
      base64: returnBase64 ? pdfBuffer.toString('base64') : undefined,
    };
  },
};
