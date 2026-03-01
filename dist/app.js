export default {
  id: 'generate-pdf-operation',
  name: 'Generate PDF',
  icon: 'picture_as_pdf',
  description: 'Generate any PDF from JSON template/inputs using pdfme',
  overview: ({ filename, store_file }) => [
    {
      label: 'File',
      text: filename || 'document.pdf',
    },
    {
      label: 'Save in files',
      text: store_file === false ? 'No' : 'Yes',
    },
  ],
  options: [
    {
      field: 'template',
      name: 'Template JSON',
      type: 'json',
      meta: {
        width: 'full',
        interface: 'input-code',
        options: {
          language: 'json',
          lineNumber: true,
        },
        note: 'pdfme template object. If empty, a blank template is created.',
      },
    },
    {
      field: 'inputs',
      name: 'Inputs JSON',
      type: 'json',
      meta: {
        width: 'full',
        interface: 'input-code',
        options: {
          language: 'json',
          lineNumber: true,
        },
        note: 'Object or array of objects. If empty, uses [{}].',
      },
    },
    {
      field: 'generate_options',
      name: 'Generate Options JSON',
      type: 'json',
      meta: {
        width: 'full',
        interface: 'input-code',
        options: {
          language: 'json',
          lineNumber: true,
        },
        note: 'Optional options passed to pdfme generate()',
      },
    },
    {
      field: 'background_image',
      name: 'Background Image',
      type: 'string',
      meta: {
        width: 'full',
        interface: 'input',
        note: 'Optional data URL, same-host /assets/<file_id> URL, or Directus file ID used as full page background',
      },
    },
    {
      field: 'filename',
      name: 'Filename',
      type: 'string',
      schema: {
        default_value: 'document.pdf',
      },
      meta: {
        width: 'half',
        interface: 'input',
      },
    },
    {
      field: 'title',
      name: 'File Title',
      type: 'string',
      meta: {
        width: 'half',
        interface: 'input',
      },
    },
    {
      field: 'storage',
      name: 'Storage',
      type: 'string',
      schema: {
        default_value: 'local',
      },
      meta: {
        width: 'half',
        interface: 'input',
      },
    },
    {
      field: 'folder',
      name: 'Folder',
      type: 'uuid',
      meta: {
        width: 'half',
        interface: 'system-folder',
        note: 'Optional folder from Directus file library',
      },
    },
    {
      field: 'store_file',
      name: 'Save to Directus Files',
      type: 'boolean',
      schema: {
        default_value: true,
      },
      meta: {
        width: 'half',
        interface: 'boolean',
      },
    },
    {
      field: 'return_base64',
      name: 'Return Base64',
      type: 'boolean',
      schema: {
        default_value: false,
      },
      meta: {
        width: 'half',
        interface: 'boolean',
      },
    },
  ],
};
