// Hand-written OpenAPI 3.0 spec for the Auto Pal API, served via Swagger UI at
// /docs. Kept in sync with the route modules by hand.

const bearer = [{ bearerAuth: [] }];

// ── Reusable schemas ────────────────────────────────────────────────────────
const schemas = {
  Error: {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        properties: {
          code: { type: 'string', example: 'BAD_REQUEST' },
          message: { type: 'string' },
          details: { type: 'object', nullable: true },
        },
      },
    },
  },
  AuthUser: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      displayName: { type: 'string' },
      phoneNumber: { type: 'string' },
      profileImageUrl: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  AuthResponse: {
    type: 'object',
    properties: {
      user: { $ref: '#/components/schemas/AuthUser' },
      accessToken: { type: 'string' },
      refreshToken: { type: 'string' },
    },
  },
  Preferences: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      userId: { type: 'string', format: 'uuid' },
      distanceUnit: { type: 'string', enum: ['km', 'mi'] },
      fuelVolumeUnit: { type: 'string', enum: ['liter', 'gallon'] },
      currency: { type: 'string', example: 'LKR' },
      autoBackupEnabled: { type: 'boolean' },
      backupFrequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'off'] },
      lastBackupAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  TrackerItem: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      vehicleId: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      lastServiceDate: { type: 'string', format: 'date-time', nullable: true },
      lastServiceMileage: { type: 'number', nullable: true },
      nextServiceDate: { type: 'string', format: 'date-time', nullable: true },
      nextServiceMileage: { type: 'number', nullable: true },
    },
  },
  Vehicle: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      userId: { type: 'string', format: 'uuid' },
      type: { type: 'string', enum: ['petrol', 'diesel', 'electric', 'hybrid', 'plugin_hybrid'] },
      vehicleType: { type: 'string', enum: ['car', 'van', 'bike', 'truck', 'suv'] },
      make: { type: 'string' },
      model: { type: 'string' },
      year: { type: 'integer', example: 2019 },
      licensePlate: { type: 'string', example: 'CAC 8515' },
      currentMileage: { type: 'number' },
      colour: { type: 'string', nullable: true },
      nickname: { type: 'string', nullable: true },
      nextServiceMileage: { type: 'number', nullable: true },
      lastServiceMileage: { type: 'number', nullable: true },
      serviceStation: { type: 'string', nullable: true },
      batteryVoltage: { type: 'number', nullable: true },
      engineOilPercentage: { type: 'number', nullable: true },
      gearOilStatus: { type: 'string', nullable: true },
      tirePressurePsi: { type: 'number', nullable: true },
      lastFuelType: { type: 'string', nullable: true },
      lastPricePerLiter: { type: 'number', nullable: true },
      batteryCapacityKwh: { type: 'number', nullable: true },
      sortOrder: { type: 'integer' },
      trackers: { type: 'array', items: { $ref: '#/components/schemas/TrackerItem' } },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  VehicleInput: {
    type: 'object',
    required: ['type', 'vehicleType', 'make', 'model', 'year', 'licensePlate', 'currentMileage'],
    properties: {
      type: { type: 'string', enum: ['petrol', 'diesel', 'electric', 'hybrid', 'plugin_hybrid'] },
      vehicleType: { type: 'string', enum: ['car', 'van', 'bike', 'truck', 'suv'] },
      make: { type: 'string' },
      model: { type: 'string' },
      year: { type: 'integer' },
      licensePlate: { type: 'string' },
      currentMileage: { type: 'number' },
      colour: { type: 'string', nullable: true },
      nickname: { type: 'string', nullable: true },
      batteryCapacityKwh: { type: 'number', nullable: true, description: 'Required for electric / plugin_hybrid' },
    },
  },
  FuelRecord: {
    type: 'object',
    required: ['vehicleId', 'date', 'liters', 'fuelType', 'odometer', 'pricePerLiter'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      vehicleId: { type: 'string', format: 'uuid' },
      date: { type: 'string', format: 'date-time' },
      liters: { type: 'number' },
      fuelType: { type: 'string', example: 'Petrol 92' },
      odometer: { type: 'number' },
      pricePerLiter: { type: 'number' },
      stationName: { type: 'string', nullable: true },
      isFullTank: { type: 'boolean' },
    },
  },
  ServiceRecord: {
    type: 'object',
    required: ['vehicleId', 'dateOfService', 'serviceType', 'mileageAtService'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      vehicleId: { type: 'string', format: 'uuid' },
      dateOfService: { type: 'string', format: 'date-time' },
      serviceType: { type: 'string' },
      mileageAtService: { type: 'number' },
      cost: { type: 'number', nullable: true },
      serviceStation: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      nextServiceMileage: { type: 'number', nullable: true },
      attachmentUrl: { type: 'string', nullable: true },
      attachmentFileName: { type: 'string', nullable: true },
    },
  },
  Reminder: {
    type: 'object',
    required: ['vehicleId', 'serviceType', 'triggerType', 'triggerValue'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      vehicleId: { type: 'string', format: 'uuid' },
      serviceType: { type: 'string' },
      triggerType: { type: 'string', enum: ['days', 'mileage'] },
      triggerValue: { type: 'number' },
      notes: { type: 'string', nullable: true },
      preferredServiceProvider: { type: 'string', nullable: true },
      isDone: { type: 'boolean' },
    },
  },
  Document: {
    type: 'object',
    required: ['title', 'documentType'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      title: { type: 'string' },
      documentType: {
        type: 'string',
        enum: ['driversLicense', 'revenueLicense', 'insurance', 'registration', 'emissionTest', 'other'],
      },
      fileUrl: { type: 'string', nullable: true },
      fileName: { type: 'string', nullable: true },
      expiryDate: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  DriverLicense: {
    type: 'object',
    required: ['fullName', 'licenseNumber'],
    properties: {
      fullName: { type: 'string' },
      licenseNumber: { type: 'string' },
      dateOfBirth: { type: 'string', format: 'date-time', nullable: true },
      licenceClass: { type: 'string' },
      address: { type: 'string' },
      issuedDate: { type: 'string', format: 'date-time', nullable: true },
      expiryDate: { type: 'string', format: 'date-time', nullable: true },
    },
  },
};

// Shorthand builders to keep the paths block readable.
const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
const vehicleIdParam = {
  name: 'vehicleId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
const vehicleIdQuery = {
  name: 'vehicleId',
  in: 'query',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

const jsonBody = (ref: string, required = true) => ({
  required,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } },
});
const multipart = (field: string) => ({
  required: true,
  content: {
    'multipart/form-data': {
      schema: {
        type: 'object',
        properties: { [field]: { type: 'string', format: 'binary' } },
      },
    },
  },
});
const ok = (ref?: string, description = 'Success') => ({
  '200': {
    description,
    ...(ref ? { content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } } } : {}),
  },
});
const noContent = { '204': { description: 'Deleted' } };

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Auto Pal API',
    version: '1.0.0',
    description:
      'REST API for the Auto Pal vehicle maintenance app. Authenticate via /auth, ' +
      'then click **Authorize** and paste the `accessToken` to try secured endpoints.',
  },
  servers: [{ url: '/api', description: 'Current host' }],
  tags: [
    { name: 'Auth' },
    { name: 'Profile' },
    { name: 'Preferences' },
    { name: 'Vehicles' },
    { name: 'Trackers' },
    { name: 'Fuel Records' },
    { name: 'Service Records' },
    { name: 'Reminders' },
    { name: 'Documents' },
    { name: 'Driving Licence' },
    { name: 'Backup & Sync' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas,
  },
  security: bearer,
  paths: {
    '/health': {
      get: { tags: ['Backup & Sync'], summary: 'Liveness probe', security: [], responses: ok(undefined, 'ok') },
    },

    // ── Auth ────────────────────────────────────────────────────────────
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Create an account',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['phoneNumber', 'password', 'displayName'],
                properties: {
                  phoneNumber: { type: 'string' },
                  password: { type: 'string', minLength: 8 },
                  displayName: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } } } },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Sign in with phone number + password',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['phoneNumber', 'password'],
                properties: { phoneNumber: { type: 'string' }, password: { type: 'string' } },
              },
            },
          },
        },
        responses: ok('AuthResponse'),
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Exchange a refresh token for a new token pair',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['refreshToken'], properties: { refreshToken: { type: 'string' } } },
            },
          },
        },
        responses: ok(),
      },
    },

    // ── Profile ─────────────────────────────────────────────────────────
    '/profile': {
      get: { tags: ['Profile'], summary: 'Read profile', responses: ok() },
      put: { tags: ['Profile'], summary: 'Update display name / phone', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { displayName: { type: 'string' }, phoneNumber: { type: 'string' } } } } } }, responses: ok() },
      delete: { tags: ['Profile'], summary: 'Delete account (cascades)', responses: noContent },
    },
    '/profile/password': {
      patch: {
        tags: ['Profile'],
        summary: 'Change password',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['newPassword'], properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string', minLength: 8 } } } } } },
        responses: ok(),
      },
    },
    '/profile/photo': {
      post: { tags: ['Profile'], summary: 'Upload avatar', requestBody: multipart('photo'), responses: ok() },
      get: { tags: ['Profile'], summary: 'Download avatar', responses: { '200': { description: 'Image', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } } },
      delete: { tags: ['Profile'], summary: 'Remove avatar', responses: noContent },
    },

    // ── Preferences ─────────────────────────────────────────────────────
    '/preferences': {
      get: { tags: ['Preferences'], summary: 'Read preferences', responses: ok('Preferences') },
      patch: { tags: ['Preferences'], summary: 'Update preferences', requestBody: jsonBody('Preferences', false), responses: ok('Preferences') },
    },

    // ── Vehicles ────────────────────────────────────────────────────────
    '/vehicles': {
      get: { tags: ['Vehicles'], summary: 'List garage', responses: ok() },
      post: { tags: ['Vehicles'], summary: 'Create vehicle', requestBody: jsonBody('VehicleInput'), responses: ok('Vehicle') },
    },
    '/vehicles/reorder': {
      patch: {
        tags: ['Vehicles'],
        summary: 'Reorder the garage',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['orderedIds'], properties: { orderedIds: { type: 'array', items: { type: 'string', format: 'uuid' } } } } } } },
        responses: ok(),
      },
    },
    '/vehicles/{id}': {
      parameters: [idParam],
      get: { tags: ['Vehicles'], summary: 'Read vehicle', responses: ok('Vehicle') },
      put: { tags: ['Vehicles'], summary: 'Create or update at a client id', requestBody: jsonBody('VehicleInput'), responses: ok('Vehicle') },
      patch: { tags: ['Vehicles'], summary: 'Partial update', requestBody: jsonBody('VehicleInput', false), responses: ok('Vehicle') },
      delete: { tags: ['Vehicles'], summary: 'Delete vehicle (cascades)', responses: noContent },
    },

    // ── Trackers ────────────────────────────────────────────────────────
    '/vehicles/{vehicleId}/trackers': {
      parameters: [vehicleIdParam],
      get: { tags: ['Trackers'], summary: 'List trackers', responses: ok() },
      post: { tags: ['Trackers'], summary: 'Create tracker', requestBody: jsonBody('TrackerItem'), responses: ok('TrackerItem') },
    },
    '/vehicles/{vehicleId}/trackers/{id}': {
      parameters: [vehicleIdParam, idParam],
      get: { tags: ['Trackers'], summary: 'Read tracker', responses: ok('TrackerItem') },
      put: { tags: ['Trackers'], summary: 'Create or update tracker', requestBody: jsonBody('TrackerItem'), responses: ok('TrackerItem') },
      patch: { tags: ['Trackers'], summary: 'Partial update', requestBody: jsonBody('TrackerItem', false), responses: ok('TrackerItem') },
      delete: { tags: ['Trackers'], summary: 'Delete tracker', responses: noContent },
    },

    // ── Fuel records ────────────────────────────────────────────────────
    '/fuel-records': {
      get: { tags: ['Fuel Records'], summary: 'List for a vehicle', parameters: [vehicleIdQuery], responses: ok() },
    },
    '/fuel-records/{id}': {
      parameters: [idParam],
      get: { tags: ['Fuel Records'], summary: 'Read fuel record', responses: ok('FuelRecord') },
      put: { tags: ['Fuel Records'], summary: 'Create or update', requestBody: jsonBody('FuelRecord'), responses: ok('FuelRecord') },
      delete: { tags: ['Fuel Records'], summary: 'Delete', responses: noContent },
    },

    // ── Service records ─────────────────────────────────────────────────
    '/service-records': {
      get: { tags: ['Service Records'], summary: 'List for a vehicle', parameters: [vehicleIdQuery], responses: ok() },
    },
    '/service-records/{id}': {
      parameters: [idParam],
      get: { tags: ['Service Records'], summary: 'Read service record', responses: ok('ServiceRecord') },
      put: { tags: ['Service Records'], summary: 'Create or update', requestBody: jsonBody('ServiceRecord'), responses: ok('ServiceRecord') },
      delete: { tags: ['Service Records'], summary: 'Delete', responses: noContent },
    },
    '/service-records/{id}/attachment': {
      parameters: [idParam],
      post: { tags: ['Service Records'], summary: 'Upload attachment', requestBody: multipart('attachment'), responses: ok('ServiceRecord') },
      get: { tags: ['Service Records'], summary: 'Download attachment', responses: { '200': { description: 'File', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } } },
    },

    // ── Reminders ───────────────────────────────────────────────────────
    '/reminders': {
      get: { tags: ['Reminders'], summary: 'List for a vehicle', parameters: [vehicleIdQuery], responses: ok() },
    },
    '/reminders/{id}': {
      parameters: [idParam],
      get: { tags: ['Reminders'], summary: 'Read reminder', responses: ok('Reminder') },
      put: { tags: ['Reminders'], summary: 'Create or update', requestBody: jsonBody('Reminder'), responses: ok('Reminder') },
      patch: { tags: ['Reminders'], summary: 'Partial update', requestBody: jsonBody('Reminder', false), responses: ok('Reminder') },
      delete: { tags: ['Reminders'], summary: 'Delete', responses: noContent },
    },

    // ── Documents ───────────────────────────────────────────────────────
    '/documents': {
      get: { tags: ['Documents'], summary: 'List documents', responses: ok() },
      post: { tags: ['Documents'], summary: 'Create document', requestBody: jsonBody('Document'), responses: ok('Document') },
    },
    '/documents/{id}': {
      parameters: [idParam],
      get: { tags: ['Documents'], summary: 'Read document', responses: ok('Document') },
      patch: { tags: ['Documents'], summary: 'Partial update', requestBody: jsonBody('Document', false), responses: ok('Document') },
      delete: { tags: ['Documents'], summary: 'Delete', responses: noContent },
    },
    '/documents/{id}/file': {
      parameters: [idParam],
      post: { tags: ['Documents'], summary: 'Upload file', requestBody: multipart('file'), responses: ok('Document') },
      get: { tags: ['Documents'], summary: 'Download file', responses: { '200': { description: 'File', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } } },
    },

    // ── Driving licence ─────────────────────────────────────────────────
    '/driving-licence': {
      get: { tags: ['Driving Licence'], summary: 'Read licence (or null)', responses: ok('DriverLicense') },
      put: { tags: ['Driving Licence'], summary: 'Create or replace', requestBody: jsonBody('DriverLicense'), responses: ok('DriverLicense') },
      delete: { tags: ['Driving Licence'], summary: 'Delete', responses: noContent },
    },

    // ── Backup & sync ───────────────────────────────────────────────────
    '/backup/export': {
      get: { tags: ['Backup & Sync'], summary: 'Full data bundle', responses: ok() },
    },
    '/backup/import': {
      post: { tags: ['Backup & Sync'], summary: 'Upsert a data bundle', requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: ok() },
    },
    '/sync': {
      get: {
        tags: ['Backup & Sync'],
        summary: 'Delta changes + deletions since a timestamp',
        parameters: [{ name: 'since', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } }],
        responses: ok(),
      },
    },
  },
};
