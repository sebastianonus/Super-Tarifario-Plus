import { ChangeEvent, ClipboardEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import mammoth from 'mammoth/mammoth.browser';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { texts } from './texts';
import onusExpressJulio27 from './data/onusExpressJulio27.json';
import districenter from './data/districenter.json';
import meteor from './data/meteor.json';
import heroBackgroundVideo from './assets/video/hero-background.mp4';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type SpeechRecognitionResultItem = {
  transcript: string;
};

type SpeechRecognitionResultListItem = {
  isFinal: boolean;
  [index: number]: SpeechRecognitionResultItem;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: SpeechRecognitionResultListItem[] }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

type CatalogItem = {
  id: string;
  sheetName?: string;
  originalDescription?: string;
  originalValues?: string[];
  code: string;
  name: string;
  unit: string;
  unitPrice: number;
  minimum: number;
  notes: string;
  criteria?: Record<string, string>;
};

type Catalog = {
  id: string;
  name: string;
  description: string;
  criteriaColumns: string[];
  items: CatalogItem[];
};

type QuoteLine = {
  itemId: string;
  itemName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  total: number;
};

type PricingResult = {
  family: string;
  pricingModel: string;
  currency: string;
  status?: string;
  reason?: string;
  minimumAllowedPrice: number | null;
  recommendedPrice?: number | null;
  referencePrice?: number | null;
  appliedClientPrice?: number | null;
  breakdown: Array<{
    code: string;
    label: string;
    type?: string;
    amount: number;
    meta?: Record<string, unknown> | null;
  }>;
  meta?: Record<string, unknown> | null;
  tariffVersion?: string;
  workflowRules?: {
    source?: string;
    minimumPriceEnforced?: boolean;
    distanceCalculatedFromRoute?: boolean;
    familyOutput?: Record<string, string>;
  };
  financialSummary?: {
    base_imponible: number;
    iva_porcentaje: number;
    iva_importe: number;
    total_con_iva: number;
    calculatedBy: string;
  };
};

type PricingRequest = {
  family?: string | null;
  serviceLevel?: string | null;
  distributionType?: string | null;
  destination?: string | null;
  zone?: string | null;
  vehicleType?: string | null;
  schedule?: string | null;
  temperature?: string | null;
  distanceKm?: number | null;
  weightKg?: number | null;
  driverCount?: number | null;
  serviceDays?: number | null;
  additionalStops?: number | null;
  waitHours?: number | null;
  modality?: string[] | null;
  roundTrip?: boolean | null;
  liftPlatform?: boolean | null;
  batchedRoute?: boolean | null;
  quantity?: number | null;
  clientPrice?: number | null;
  tariffId?: string | null;
  tariffName?: string | null;
  mozoHours?: number | null;
  mozoCount?: number | null;
  mozoManualPrice?: number | null;
  operationalSurcharges?: {
    emptyDeparture?: boolean | null;
    requestLessThan48h?: boolean | null;
    requestLessThan24h?: boolean | null;
    sporadicRoute?: boolean | null;
    changePointConditions?: boolean | null;
    secondAttemptPenalty?: boolean | null;
    waitBlocks30m?: number | null;
    cancellationHoursBefore?: number | null;
  } | null;
  notes?: string | null;
  originAddress?: string | null;
  destinationAddress?: string | null;
  routeAddresses?: string[] | null;
  routeHasTimeConstraints?: boolean | null;
  routeOptimization?: boolean | null;
  vehicleSchedule?: string | null;
  mozoSchedule?: string | null;
  loadZone?: string | null;
  deliveryZone?: string | null;
  estimatedStops?: number | null;
};

type MapDistanceResult = {
  distanceKm: number;
  distanceText: string;
  durationText: string;
  origin: string;
  destination: string;
  optimized?: boolean;
  addresses?: string[];
};

type PlacePrediction = {
  description: string;
  placeId: string;
  mainText?: string;
  secondaryText?: string;
};

type ServiceAnalysis = {
  request: string;
  catalogName: string;
  clientName: string;
  summary: string;
  assumptions: string[];
  missingData: string[];
  candidateServices: string[];
  aiCandidateLines?: QuoteLine[];
  pricingRequest?: PricingRequest | null;
  pricingResult?: PricingResult;
};

type ThinkingState = 'idle' | 'documents' | 'analysis' | 'pricing';

type AppData = {
  catalogs: Catalog[];
};

type LoginSession = {
  clientId: string;
  clientName: string;
  code: string;
  role: 'admin' | 'client';
  allowedCatalogIds: string[];
  isActive: boolean;
};

const acceptedUploadTypes = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/webp'
];

const defaultData: AppData = {
  catalogs: [
    {
      ...(onusExpressJulio27 as Catalog),
      name: 'Onus Express 2026',
      description: 'Tarifario Onus Express 2026 cargado desde VS Code.'
    },
    districenter as Catalog,
    meteor as Catalog
  ]
};

const initialAccessUsers: LoginSession[] = [
  {
    clientId: 'onus',
    clientName: 'Onus Express',
    code: '7257',
    role: 'admin',
    allowedCatalogIds: ['*'],
    isActive: true
  },
  {
    clientId: 'meteor',
    clientName: 'Meteor',
    code: 'meteor2026',
    role: 'client',
    allowedCatalogIds: ['meteor'],
    isActive: true
  },
  {
    clientId: 'districenter',
    clientName: 'Districenter',
    code: 'districenter2026',
    role: 'client',
    allowedCatalogIds: ['districenter'],
    isActive: true
  }
];

const accessUsersStorageKey = 'super-tarifario-plus.access-users.v1';

function isValidAccessUser(value: unknown): value is LoginSession {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const user = value as Partial<LoginSession>;
  return (
    typeof user.clientId === 'string' &&
    typeof user.clientName === 'string' &&
    typeof user.code === 'string' &&
    (user.role === 'admin' || user.role === 'client') &&
    Array.isArray(user.allowedCatalogIds) &&
    typeof user.isActive === 'boolean'
  );
}

function loadAccessUsersFromStorage() {
  try {
    const stored = window.localStorage.getItem(accessUsersStorageKey);
    if (!stored) {
      return initialAccessUsers;
    }

    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return initialAccessUsers;
    }

    const users = parsed.filter(isValidAccessUser);
    return users.length > 0 ? users : initialAccessUsers;
  } catch {
    return initialAccessUsers;
  }
}

function saveAccessUsersToStorage(users: LoginSession[]) {
  try {
    window.localStorage.setItem(accessUsersStorageKey, JSON.stringify(users));
  } catch {
    // La app sigue funcionando aunque el navegador bloquee el almacenamiento local.
  }
}

async function fetchSupabaseStatus() {
  const response = await fetch('/api/supabase/status');
  if (!response.ok) {
    return false;
  }

  const payload = await response.json();
  return Boolean(payload.configured);
}

async function loginWithSupabase(client: string, code: string) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client, code })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || texts.login.error);
  }

  return payload.session as LoginSession;
}

async function fetchAccessUsersFromApi() {
  const response = await fetch('/api/admin/access-users');
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || texts.admin.saveError);
  }

  return Array.isArray(payload.users) ? payload.users.filter(isValidAccessUser) : [];
}

async function saveAccessUsersToApi(users: LoginSession[]) {
  const response = await fetch('/api/admin/access-users', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ users })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || texts.admin.saveError);
  }

  return Array.isArray(payload.users) ? payload.users.filter(isValidAccessUser) : users;
}

const currencyFormatter = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'EUR'
});

const directVehicleOptionsByTemperature: Record<string, string[]> = {
  seco: ['Furgoneta (ligera)', 'Furgón L2H2', 'Carrozado', 'Rígido 12T', 'Moto'],
  frio: ['Furgoneta (ligera)', 'Furgón L2H2', 'Carrozado', 'Rígido 12T'],
  refrigerado: ['Furgoneta (ligera)', 'Furgón L2H2', 'Carrozado', 'Rígido 12T'],
  congelado: ['Furgoneta (ligera)', 'Furgón L2H2', 'Carrozado', 'Rígido 12T']
};

const lastMileVehicleOptionsByTemperature: Record<string, string[]> = {
  seco: ['Tipo A (3 m³ - 1 pallet)', 'Tipo B (6 m³ - 2 pallets)', 'Tipo C (12 m³)', 'Tipo D (Carrozado)', 'Tipo E (Moto)', 'Tipo F (Bici)'],
  refrigerado: ['Tipo A (3 m³ - 1 pallet)', 'Tipo B (6 m³ - 2 pallets)', 'Tipo C (12 m³)', 'Tipo D (Carrozado)'],
  frio: ['Tipo A (3 m³ - 1 pallet)', 'Tipo B (6 m³ - 2 pallets)', 'Tipo C (12 m³)', 'Tipo D (Carrozado)']
};

const scheduleOptions = [
  { value: 'media_jornada', label: 'Media jornada' },
  { value: 'jornada_completa', label: 'Jornada completa' },
  { value: 'refuerzo_max_3h', label: 'Refuerzo max. 3 h' }
];

const scheduleHours: Record<string, number> = {
  media_jornada: 4,
  jornada_completa: 8,
  refuerzo_max_3h: 3
};

const waitHourOptions = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 9, 10, 12];
const onusVehicleOptions = mergeOptionLists(
  Object.values(directVehicleOptionsByTemperature).flat(),
  Object.values(lastMileVehicleOptionsByTemperature).flat()
);
const districenterVehicleOptions = ['Furgoneta', 'Camión 6,5', 'Camión 8-9', 'Tráiler'];
const meteorVehicleOptions = [
  'Tipo A (3 m³ - 1 palet)',
  'Tipo B (6 m³ - 2 palets)',
  'Tipo C (12 m³)',
  'Tipo D (Carrozado con plataforma)',
  'Tipo E (Moto)',
  'Tipo F (Bicicleta)'
];

function getVehicleOptionsForCatalog(catalogIdOrName?: string | null, family?: string | null, temperature?: string | null) {
  const catalog = normalizeText(catalogIdOrName);
  if (catalog.includes('districenter')) {
    return districenterVehicleOptions;
  }
  if (catalog.includes('meteor')) {
    return meteorVehicleOptions;
  }
  const temperatureKey = temperature === 'refrigerado' ? 'frio' : temperature || 'seco';
  if (family === 'ultima_milla') {
    return lastMileVehicleOptionsByTemperature[temperatureKey] ?? lastMileVehicleOptionsByTemperature.seco;
  }
  if (family === 'directos') {
    return directVehicleOptionsByTemperature[temperatureKey] ?? directVehicleOptionsByTemperature.seco;
  }
  return onusVehicleOptions;
}

function findAllowedVehicle(value: unknown, allowedVehicles: string[]) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  return allowedVehicles.find((vehicle) => normalizeText(vehicle) === normalized) ?? null;
}

type VehicleOptionIndex = {
  general: string[];
  byCatalogId: Record<string, string[]>;
};

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function repairImportedText(value: unknown) {
  return String(value ?? '')
    .replace(/Ã¡/g, 'á')
    .replace(/Ã©/g, 'é')
    .replace(/Ã­/g, 'í')
    .replace(/Ã³/g, 'ó')
    .replace(/Ãº/g, 'ú')
    .replace(/Ã€/g, 'Á')
    .replace(/Ã‰/g, 'É')
    .replace(/Ã/g, 'Í')
    .replace(/Ã“/g, 'Ó')
    .replace(/Ãš/g, 'Ú')
    .replace(/Ã±/g, 'ñ')
    .replace(/Âº/g, 'º')
    .replace(/Âª/g, 'ª')
    .replace(/Â³/g, '³')
    .replace(/â€“/g, '-')
    .replace(/â€”/g, '-')
    .replace(/â‚¬/g, '€')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(value: unknown) {
  return repairImportedText(value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function resolveLoginSession(client: string, code: string, accessUsers: LoginSession[]) {
  const normalizedClient = normalizeText(client);
  const normalizedCode = code.trim();

  return (
    accessUsers.find(
      (session) =>
        session.isActive &&
        normalizedCode === session.code &&
        (normalizeText(session.clientId) === normalizedClient || normalizeText(session.clientName) === normalizedClient)
    ) ?? null
  );
}

function isCatalogAllowedForSession(catalog: Catalog, session: LoginSession | null) {
  if (!session) {
    return false;
  }

  return session.allowedCatalogIds.includes('*') || session.allowedCatalogIds.includes(catalog.id);
}

function normalizeVehicleTypeForPricing(value: unknown, fallback?: string | null) {
  const text = normalizeText(value);

  if (text.includes('moto')) {
    return 'Moto';
  }

  if (text.includes('rigido') || text.includes('12t')) {
    return 'Rígido 12T';
  }

  if (text.includes('carroz') || text.includes('camion') || text.includes('3500') || text.includes('plataforma')) {
    return 'Carrozado';
  }

  if (text.includes('l2h2')) {
    return 'Furgón L2H2';
  }

  if (text.includes('furgon') || text.includes('furgoneta') || text.includes('van')) {
    return 'Furgoneta (ligera)';
  }

  return fallback ?? null;
}

function mergeOptionLists(...lists: Array<Array<string | null | undefined> | undefined>) {
  const options: string[] = [];
  const seen = new Set<string>();

  for (const list of lists) {
    for (const option of list ?? []) {
      const cleaned = repairImportedText(option);
      const key = normalizeText(cleaned);
      if (!cleaned || seen.has(key)) {
        continue;
      }
      seen.add(key);
      options.push(cleaned);
    }
  }

  return options;
}

function canonicalVehicleOptionFromText(value: unknown) {
  const text = repairImportedText(value);
  const normalized = normalizeText(text);

  if (!normalized || normalized.includes('tipo de vehiculo') || normalized.includes('tipo de vehicle') || normalized.includes('mozo')) {
    return null;
  }

  const typeMatch = text.match(/\bTipo\s+([A-F])\s*(\([^)]*\))?/i);
  if (typeMatch) {
    const typeLetter = typeMatch[1].toUpperCase();
    const detail = typeMatch[2]?.replace(/\s+/g, ' ').trim();
    return detail ? `Tipo ${typeLetter} ${detail}` : `Tipo ${typeLetter}`;
  }

  if (normalized.includes('trailer')) {
    return 'Tráiler';
  }

  if ((normalized.includes('camio') || normalized.includes('camion')) && (normalized.includes('8-9') || normalized.includes('8 9'))) {
    return 'Camión 8-9';
  }

  if ((normalized.includes('camio') || normalized.includes('camion')) && (normalized.includes('6,5') || normalized.includes('6.5') || normalized.includes('6 5'))) {
    return 'Camión 6,5';
  }

  if (normalized.includes('rigido') || normalized.includes('12t')) {
    return 'Rígido 12T';
  }

  if (normalized.includes('carrozado') || normalized.includes('carroz')) {
    return 'Carrozado';
  }

  if (normalized.includes('l2h2')) {
    return 'Furgón L2H2';
  }

  if (normalized.includes('furgoneta')) {
    return normalized.includes('ligera') ? 'Furgoneta (ligera)' : 'Furgoneta';
  }

  if (normalized.includes('furgon')) {
    return 'Furgón L2H2';
  }

  if (normalized.includes('moto')) {
    return 'Moto';
  }

  if (normalized.includes('bici')) {
    return 'Bici';
  }

  return null;
}

function extractVehicleOptionsFromCatalog(catalog: Catalog) {
  const options: string[] = [];

  for (const item of catalog.items ?? []) {
    const sourceValues = [
      item.name,
      item.originalDescription,
      item.sheetName,
      ...(item.originalValues ?? []),
      ...Object.values(item.criteria ?? {})
    ];

    for (const sourceValue of sourceValues) {
      const lines = repairImportedText(sourceValue).split(/\n| {2,}/);
      for (const line of lines) {
        const option = canonicalVehicleOptionFromText(line);
        if (option) {
          options.push(option);
        }
      }
    }
  }

  return mergeOptionLists(options);
}

function buildVehicleOptionIndex(catalogs: Catalog[]): VehicleOptionIndex {
  const byCatalogId: Record<string, string[]> = {};

  for (const catalog of catalogs) {
    byCatalogId[catalog.id] = extractVehicleOptionsFromCatalog(catalog);
  }

  return {
    byCatalogId,
    general: mergeOptionLists(
      onusVehicleOptions,
      districenterVehicleOptions,
      meteorVehicleOptions
    )
  };
}

function normalizeVehicleTypeForCatalog(value: unknown, catalogIdOrName?: string | null, fallback?: string | null) {
  const text = normalizeText(`${value ?? ''}\n${fallback ?? ''}`);
  const catalog = normalizeText(catalogIdOrName);

  if (catalog.includes('districenter')) {
    if (text.includes('trailer')) {
      return 'Tráiler';
    }
    if (text.includes('8-9') || text.includes('8 9') || text.includes('camio 8') || text.includes('camion 8') || text.includes('rigido')) {
      return 'Camión 8-9';
    }
    if (text.includes('3500') || text.includes('6,5') || text.includes('6.5') || text.includes('carroz') || text.includes('camion') || text.includes('plataforma')) {
      return 'Camión 6,5';
    }
    if (text.includes('furgon') || text.includes('furgoneta') || text.includes('van')) {
      return 'Furgoneta';
    }
  }

  if (catalog.includes('meteor')) {
    if (text.includes('bici') || text.includes('bicicleta')) {
      return 'Tipo F (Bicicleta)';
    }
    if (text.includes('moto')) {
      return 'Tipo E (Moto)';
    }
    if (text.includes('carroz') || text.includes('plataforma') || text.includes('3500') || text.includes('camion')) {
      return 'Tipo D (Carrozado con plataforma)';
    }
    if (text.includes('12') || text.includes('tipo c')) {
      return 'Tipo C (12 m³)';
    }
    if (text.includes('6') || text.includes('2 palet') || text.includes('tipo b')) {
      return 'Tipo B (6 m³ - 2 palets)';
    }
    if (text.includes('3') || text.includes('1 palet') || text.includes('tipo a') || text.includes('furgon')) {
      return 'Tipo A (3 m³ - 1 palet)';
    }
  }

  return normalizeVehicleTypeForPricing(value, fallback);
}

function normalizeOnusLastMileVehicle(value: unknown, fallback?: string | null) {
  const text = normalizeText(`${value ?? ''}\n${fallback ?? ''}`);
  if (text.includes('bici') || text.includes('bicicleta')) {
    return 'Tipo F (Bici)';
  }
  if (text.includes('moto')) {
    return 'Tipo E (Moto)';
  }
  if (text.includes('carroz') || text.includes('plataforma') || text.includes('3500') || text.includes('camion')) {
    return 'Tipo D (Carrozado)';
  }
  if (text.includes('12') || text.includes('tipo c')) {
    return 'Tipo C (12 m³)';
  }
  if (text.includes('6') || text.includes('2 pal') || text.includes('mediana') || text.includes('tipo b')) {
    return 'Tipo B (6 m³ - 2 pallets)';
  }
  if (text.includes('3') || text.includes('1 pal') || text.includes('furgon') || text.includes('tipo a')) {
    return 'Tipo A (3 m³ - 1 pallet)';
  }
  return fallback ?? null;
}

function resolveVehicleForCatalog(request: PricingRequest, catalog?: Catalog, sourceText = '') {
  const catalogIdOrName = catalog?.id || catalog?.name || request.tariffId || request.tariffName;
  const allowedVehicles = getVehicleOptionsForCatalog(catalogIdOrName, request.family, request.temperature);
  const currentAllowed = findAllowedVehicle(request.vehicleType, allowedVehicles);
  if (currentAllowed) {
    return currentAllowed;
  }

  const inferred =
    request.family === 'ultima_milla' && !normalizeText(catalogIdOrName).includes('meteor') && !normalizeText(catalogIdOrName).includes('districenter')
      ? normalizeOnusLastMileVehicle(sourceText, request.vehicleType)
      : normalizeVehicleTypeForCatalog(sourceText, catalogIdOrName, request.vehicleType);

  return findAllowedVehicle(inferred, allowedVehicles);
}

function parsePrice(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  const normalized = String(value ?? '')
    .replace(/[^\d,.-]/g, '')
    .replace(/\.(?=\d{3})/g, '')
    .replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

type AnalyzableDocument = {
  id?: string;
  fileName: string;
  text?: string;
  mimeType?: string;
  imageData?: string;
  size?: number;
  file?: File;
};

type LogisticsAnalysis = {
  estado?: string;
  servicio?: {
    fecha?: string | null;
    tipo?: string | null;
    distancia_km?: number | null;
    distance_status?: string;
    fuente_distancia?: string | null;
    duracion_horas?: number | null;
    resumen?: string;
  };
  ruta?: Array<{
    orden: number;
    tipo: string;
    direccion_original: string;
    direccion_normalizada: string;
    horario_desde?: string | null;
    horario_hasta?: string | null;
    contacto?: string | null;
    telefono?: string | null;
    mercancia_recogida?: string[];
    mercancia_entregada?: string[];
  }>;
  mercancias?: Array<{
    descripcion: string;
    cantidad?: number | null;
    peso_confirmado_kg?: number | null;
    peso_estimado_minimo_kg?: number | null;
    peso_estimado_maximo_kg?: number | null;
    dimensiones_confirmadas?: string | null;
    dimensiones_estimadas?: string | null;
    origen?: string | null;
    destino?: string | null;
    confianza?: number;
    fuente?: string;
  }>;
  carga?: {
    bultos_fisicos_minimos?: number | null;
    bultos_fisicos_maximos?: number | null;
    movimientos_de_bultos?: number | null;
    carga_maxima_simultanea_bultos?: number | null;
    peso_confirmado_kg?: number | null;
    peso_estimado_minimo_kg?: number | null;
    peso_estimado_maximo_kg?: number | null;
    dimensiones_confirmadas?: string | null;
    vehiculo_recomendado?: string | null;
    recursos_necesarios?: string[];
  };
  datos_confirmados?: string[];
  datos_estimados?: string[];
  datos_pendientes?: string[];
  contradicciones?: string[];
  advertencias_operativas?: string[];
  texto_limpio?: string;
  serviceDescription?: string;
  tariffParameters?: {
    pickupAddresses?: string[];
    deliveryAddresses?: string[];
    stops?: number;
    packages?: string[];
    totalPackages?: number;
    weight?: string;
    dimensions?: string[];
    volume?: string;
    vehicleRequirements?: string[];
    equipment?: string[];
    goods?: string[];
    date?: string;
    pickupWindows?: string[];
    deliveryWindows?: string[];
    contacts?: string[];
  };
  missingData?: string[];
  warnings?: string[];
};

function compactSpaces(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function getBetween(text: string, start: string, endMarkers: string[]) {
  const startIndex = text.toUpperCase().indexOf(start.toUpperCase());
  if (startIndex < 0) {
    return '';
  }

  const afterStart = text.slice(startIndex + start.length);
  const endIndex = endMarkers
    .map((marker) => afterStart.toUpperCase().indexOf(marker.toUpperCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  return compactSpaces(endIndex === undefined ? afterStart : afterStart.slice(0, endIndex));
}

function matchValue(text: string, pattern: RegExp) {
  return text.match(pattern)?.[1]?.trim() ?? '';
}

function extractPackageCount(text: string) {
  return matchValue(text, /(?:unitats|unidades|bultos?|qty|cantidad)\D{0,12}(\d+)/i) || matchValue(text, /\b(\d+)\s*(?:bultos?|paquetes?|unitats|unidades)\b/i);
}

function isImageFile(file: File) {
  return file.type.startsWith('image/');
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function readPdfText(file: File) {
  const buffer = await file.arrayBuffer();
  const pdf = await getDocument({ data: buffer }).promise;
  const pageTexts: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pageTexts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }

  return pageTexts.join('\n');
}

async function analyzeServiceDocument(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase();

  if (extension === 'pdf' || file.type === 'application/pdf') {
    return readPdfText(file);
  }

  if (extension === 'docx' || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }

  if (extension === 'txt' || file.type === 'text/plain') {
    return file.text();
  }

  return `${file.name}: documento adjunto pendiente de análisis por IA.`;
}

function buildLocalDocumentSummary(documents: AnalyzableDocument[]) {
  return documents
    .map((document) => {
      if (document.imageData && document.text === texts.assistant.imageTextPending) {
        return [
          `${texts.assistant.documentSectionPrefix} ${document.fileName}`,
          'Tipo: imagen/captura con texto',
          'Pendiente: lectura OCR/vision para extraer rutas, horarios e instrucciones.'
        ].join('\n');
      }

      const text = compactSpaces(document.text ?? '');
      const deliveryBlock = getBetween(text, 'ADREÇA LLIURAMENT:', ['UNITATS DESCRIPCIO / SKU', 'NOTES :']);
      const goods = getBetween(text, 'UNITATS DESCRIPCIO / SKU', ['NOTES :']);
      const notes = getBetween(text, 'NOTES', []);
      const pickupAddress = getBetween(text, 'ADREÇA DE RECOLLIDA:', ['HORARI DE RECOLLIDA:', 'CONTACTE:', 'ADREÇA LLIURAMENT:']);
      const pickupWindow = getBetween(text, 'HORARI DE RECOLLIDA:', ['CONTACTE:', 'ADREÇA LLIURAMENT:']);
      const weight = matchValue(text, /(\d+(?:[,.]\d+)?)\s*(kg|kilos?)/i);
      const dimensions = [...text.matchAll(/(\d+(?:[,.]\d+)?\s*x\s*\d+(?:[,.]\d+)?(?:\s*x\s*\d+(?:[,.]\d+)?)?\s*(?:cm|m)?)/gi)].map((match) => match[1]);

      const fields = [
        `${texts.assistant.documentSectionPrefix} ${document.fileName}`,
        matchValue(text, /N[ºO]\s*ALBAR[ÀA]:?\s*([A-Z0-9_-]+)/i) && `Albaran: ${matchValue(text, /N[ºO]\s*ALBAR[ÀA]:?\s*([A-Z0-9_-]+)/i)}`,
        matchValue(text, /DATA:\s*([0-9./-]+)/i) && `Fecha: ${matchValue(text, /DATA:\s*([0-9./-]+)/i)}`,
        pickupAddress && `Recogida: ${pickupAddress}`,
        pickupWindow && `Horario recogida: ${pickupWindow}`,
        deliveryBlock && `Entrega: ${deliveryBlock}`,
        goods && `${texts.assistant.goods}: ${goods}`,
        goods && `Bultos/unidades detectadas: ${extractPackageCount(goods) || 'No determinado'}`,
        weight ? `Peso: ${weight}` : 'Peso: no informado',
        dimensions.length ? `Dimensiones: ${dimensions.join(' | ')}` : 'Dimensiones: no informadas',
        notes && `Instrucciones: ${notes}`,
        /TRUCAR|LLAMAR/i.test(text) && 'Accion: llamar al contacto antes de llegar.',
        /NEVERA|FRIO|FRÍO|REFRIG/i.test(text) && 'Condicion: posible material frio/refrigerado o nevera.',
        /ARMARI|ARMARIO|PRESTATGERIA|ESTANTER/i.test(text) && 'Condicion: material voluminoso.'
      ].filter(Boolean);

      return fields.join('\n');
    })
    .join('\n\n');
}

async function prepareAttachedDocumentsForAnalysis(documents: AnalyzableDocument[]) {
  return Promise.all(
    documents.map(async (document) => {
      if (!document.file) {
        return document;
      }

      try {
        if (isImageFile(document.file)) {
          return {
            id: document.id,
            fileName: document.fileName,
            text: texts.assistant.imageTextPending,
            mimeType: document.mimeType || document.file.type || 'image/png',
            imageData: await readFileAsDataUrl(document.file),
            size: document.size
          };
        }

        return {
          id: document.id,
          fileName: document.fileName,
          text: await analyzeServiceDocument(document.file),
          mimeType: document.mimeType || document.file.type,
          size: document.size
        };
      } catch {
        return {
          id: document.id,
          fileName: document.fileName,
          text: texts.imports.analysisError,
          mimeType: document.mimeType || document.file.type,
          size: document.size
        };
      }
    })
  );
}

async function analyzeDocumentsWithAi(documents: AnalyzableDocument[], catalog: Catalog, clientName: string) {
  let response: Response;
  try {
    response = await fetch('/api/analyze-document-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents, catalog, clientName })
    });
  } catch {
    throw new Error(texts.assistant.apiUnavailable);
  }

  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || 'Document AI analysis failed');
  }

  const analysis = (await response.json()) as LogisticsAnalysis;
  return {
    analysis,
    formattedText: formatDocumentAnalysisForAgent(analysis)
  };
}

function valueOrFallback(value: unknown) {
  const cleaned = String(value ?? '').trim();
  return cleaned && !/^missingData$/i.test(cleaned) ? cleaned : texts.assistant.noData;
}

function listOrFallback(values: unknown) {
  if (!Array.isArray(values)) {
    return texts.assistant.noData;
  }

  const cleaned = values.map((value) => String(value ?? '').trim()).filter((value) => value && !/^missingData$/i.test(value));
  return cleaned.length ? cleaned.map((value, index) => `${index + 1}. ${value}`).join('\n') : texts.assistant.noData;
}

function formatDocumentAnalysisForAgent(analysis: LogisticsAnalysis) {
  if (analysis.servicio || analysis.ruta || analysis.carga) {
    const routeLines = (analysis.ruta ?? [])
      .sort((a, b) => a.orden - b.orden)
      .map((stop) => {
        const windowText = [stop.horario_desde, stop.horario_hasta].filter(Boolean).join('-') || texts.assistant.noData;
        const contactText = [stop.contacto, stop.telefono].filter(Boolean).join(' · ') || texts.assistant.noData;
        const collected = stop.mercancia_recogida?.length ? stop.mercancia_recogida.join(', ') : texts.assistant.noData;
        const delivered = stop.mercancia_entregada?.length ? stop.mercancia_entregada.join(', ') : texts.assistant.noData;
        return `${stop.orden}. ${stop.tipo.toUpperCase()} | ${stop.direccion_normalizada || stop.direccion_original}\n   Horario: ${windowText}\n   Contacto: ${contactText}\n   Recoge: ${collected}\n   Entrega: ${delivered}`;
      });

    const goodsLines = (analysis.mercancias ?? []).map((item, index) => {
      const confirmedWeight = item.peso_confirmado_kg !== null && item.peso_confirmado_kg !== undefined ? `${item.peso_confirmado_kg} kg confirmados` : 'peso confirmado no informado';
      const estimatedWeight =
        item.peso_estimado_minimo_kg !== null && item.peso_estimado_minimo_kg !== undefined
          ? `estimado ${item.peso_estimado_minimo_kg}-${item.peso_estimado_maximo_kg ?? item.peso_estimado_minimo_kg} kg`
          : 'sin estimacion de peso';
      return `${index + 1}. ${item.descripcion} | cantidad: ${item.cantidad ?? texts.assistant.noData} | ${confirmedWeight} | ${estimatedWeight} | origen: ${valueOrFallback(item.origen)} | destino: ${valueOrFallback(item.destino)}`;
    });

    const sections = [
      texts.assistant.tariffableFileTitle,
      `${texts.assistant.status}: ${analysis.estado ?? texts.assistant.noData}`,
      `${texts.assistant.serviceSummary}: ${valueOrFallback(analysis.servicio?.resumen || analysis.texto_limpio)}`,
      `${texts.assistant.date}: ${valueOrFallback(analysis.servicio?.fecha)}`,
      `${texts.assistant.serviceType}: ${valueOrFallback(analysis.servicio?.tipo)}`,
      `Distancia: ${analysis.servicio?.distancia_km ?? texts.assistant.noData} km (${analysis.servicio?.distance_status ?? 'pendiente_de_calcular'})`,
      `${texts.assistant.duration}: ${analysis.servicio?.duracion_horas ?? texts.assistant.noData} h`,
      `${texts.assistant.orderedRoute}:\n${routeLines.length ? routeLines.join('\n') : texts.assistant.noData}`,
      `${texts.assistant.merchandise}:\n${goodsLines.length ? goodsLines.join('\n') : texts.assistant.noData}`,
      `${texts.assistant.maxSimultaneousLoad}: ${analysis.carga?.carga_maxima_simultanea_bultos ?? texts.assistant.noData} bultos`,
      `${texts.assistant.physicalPackages}: ${analysis.carga?.bultos_fisicos_minimos ?? texts.assistant.noData}-${analysis.carga?.bultos_fisicos_maximos ?? texts.assistant.noData}`,
      `${texts.assistant.packageMovements}: ${analysis.carga?.movimientos_de_bultos ?? texts.assistant.noData}`,
      `${texts.assistant.weight}: ${analysis.carga?.peso_confirmado_kg ?? texts.assistant.noData}`,
      `${texts.assistant.estimatedWeight}: ${analysis.carga?.peso_estimado_minimo_kg ?? texts.assistant.noData}-${analysis.carga?.peso_estimado_maximo_kg ?? texts.assistant.noData} kg`,
      `${texts.assistant.vehicleRequirements}: ${valueOrFallback(analysis.carga?.vehiculo_recomendado)}`,
      `${texts.assistant.equipment}:\n${listOrFallback(analysis.carga?.recursos_necesarios)}`,
      analysis.datos_confirmados?.length ? `${texts.assistant.confirmedData}\n${analysis.datos_confirmados.join('\n')}` : '',
      analysis.datos_estimados?.length ? `${texts.assistant.estimatedData}\n${analysis.datos_estimados.join('\n')}` : '',
      analysis.datos_pendientes?.length ? `${texts.assistant.missingCriticalData}\n${analysis.datos_pendientes.join('\n')}` : '',
      analysis.contradicciones?.length ? `${texts.assistant.contradictions}\n${analysis.contradicciones.join('\n')}` : '',
      analysis.advertencias_operativas?.length ? `${texts.assistant.warnings}\n${analysis.advertencias_operativas.join('\n')}` : '',
      analysis.texto_limpio ? `${texts.assistant.cleanText}\n${analysis.texto_limpio}` : ''
    ].filter(Boolean);

    return sections.join('\n\n');
  }

  const parameters = analysis.tariffParameters;

  const sections = [
    texts.assistant.tariffableFileTitle,
    `${texts.assistant.serviceSummary}: ${valueOrFallback(analysis.serviceDescription)}`,
    `${texts.assistant.date}: ${valueOrFallback(parameters?.date)}`,
    `${texts.assistant.stops}: ${Number(parameters?.stops) || texts.assistant.noData}`,
    `${texts.assistant.pickupAddresses}:\n${listOrFallback(parameters?.pickupAddresses)}`,
    `${texts.assistant.deliveryAddresses}:\n${listOrFallback(parameters?.deliveryAddresses)}`,
    `${texts.assistant.totalPackages}: ${Number(parameters?.totalPackages) || texts.assistant.noData}`,
    `${texts.assistant.packages}:\n${listOrFallback(parameters?.packages)}`,
    `${texts.assistant.weight}: ${valueOrFallback(parameters?.weight)}`,
    `${texts.assistant.dimensions}:\n${listOrFallback(parameters?.dimensions)}`,
    `${texts.assistant.volume}: ${valueOrFallback(parameters?.volume)}`,
    `${texts.assistant.vehicleRequirements}:\n${listOrFallback(parameters?.vehicleRequirements)}`,
    `${texts.assistant.equipment}:\n${listOrFallback(parameters?.equipment)}`,
    `${texts.assistant.goods}:\n${listOrFallback(parameters?.goods)}`,
    `${texts.assistant.pickupWindows}:\n${listOrFallback(parameters?.pickupWindows)}`,
    `${texts.assistant.deliveryWindows}:\n${listOrFallback(parameters?.deliveryWindows)}`,
    `${texts.assistant.contacts}:\n${listOrFallback(parameters?.contacts)}`,
    analysis.missingData?.length ? `${texts.assistant.missingData}\n${analysis.missingData.join('\n')}` : '',
    analysis.warnings?.length ? `${texts.assistant.warnings}\n${analysis.warnings.join('\n')}` : ''
  ].filter(Boolean);

  return sections.join('\n\n');
}

function pricingResultToQuoteLines(pricingResult?: PricingResult): QuoteLine[] {
  if (!pricingResult?.breakdown?.length) {
    return [];
  }

  return pricingResult.breakdown.map((line, index) => ({
    itemId: line.code || `pricing-${index}`,
    itemName: line.label,
    unit: String(line.meta?.unit || (line.type === 'discount' ? 'Descuento' : line.type === 'surcharge' ? 'Recargo' : 'Servicio')),
    quantity: Number(line.meta?.quantity ?? 1) || 1,
    unitPrice: Number(line.meta?.unitPrice ?? line.amount) || 0,
    total: Number(line.amount) || 0
  }));
}

type QuoteDocumentMode = 'quote' | 'proposal';

function buildQuoteSubject(analysis: ServiceAnalysis | null, displayedClient: string, displayedTariff: string, mode: QuoteDocumentMode) {
  const template = mode === 'proposal' ? texts.assistant.proposalDefaultSubject : texts.assistant.quoteDefaultSubject;
  return template
    .replace('{client}', displayedClient || texts.system.defaultClient)
    .replace('{tariff}', displayedTariff || analysis?.catalogName || texts.assistant.noData);
}

function buildQuoteDraftText(lines: QuoteLine[], analysis: ServiceAnalysis | null, displayedClient: string, displayedTariff: string, mode: QuoteDocumentMode) {
  const financialSummary = analysis?.pricingResult?.financialSummary;
  const total = lines.reduce((sum, line) => sum + line.total, 0);
  const serviceSummary = analysis?.summary?.trim();
  const routeDistance = analysis?.pricingRequest?.distanceKm;
  const introLines = [
    texts.assistant.quoteGreeting,
    '',
    mode === 'proposal' ? texts.assistant.proposalIntro : texts.assistant.quoteIntro,
    '',
    `Cliente: ${displayedClient || texts.system.defaultClient}`,
    `Tarifario: ${displayedTariff || texts.assistant.noData}`
  ];

  if (serviceSummary) {
    introLines.push(`Servicio: ${serviceSummary}`);
  }

  if (routeDistance) {
    introLines.push(`Distancia considerada: ${routeDistance.toLocaleString('es-ES')} km`);
  }

  const detailLines = lines.map((line) => {
    const quantity = `${line.quantity} ${line.unit}`.trim();
    return `- ${line.itemName}: ${quantity} x ${currencyFormatter.format(line.unitPrice)} = ${currencyFormatter.format(line.total)}`;
  });

  const totalLines = financialSummary
    ? [
        `Base imponible: ${currencyFormatter.format(financialSummary.base_imponible)}`,
        `IVA ${financialSummary.iva_porcentaje}%: ${currencyFormatter.format(financialSummary.iva_importe)}`,
        `Total con IVA: ${currencyFormatter.format(financialSummary.total_con_iva)}`
      ]
    : [`Total propuesta: ${currencyFormatter.format(total)}`];

  return [
    ...introLines,
    '',
    'Desglose:',
    ...detailLines,
    '',
    ...totalLines,
    '',
    mode === 'proposal' ? texts.assistant.proposalValidity : texts.assistant.quoteValidity,
    '',
    texts.assistant.quoteSignature
  ].join('\n');
}

function formatMetaValue(value: unknown): string {
  const textMap: Record<string, string> = {
    media_jornada: 'Media jornada',
    jornada_completa: 'Jornada completa',
    refuerzo_max_3h: 'Refuerzo máximo 3 h',
    weightKg: 'Peso',
    volume: 'Volumen',
    numberOfPackages: 'Número de bultos',
    dimensions: 'Dimensiones'
  };

  if (typeof value === 'string' && textMap[value]) {
    return textMap[value];
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toLocaleString('es-ES', { maximumFractionDigits: 3 });
  }

  if (typeof value === 'boolean') {
    return value ? 'Sí' : 'No';
  }

  if (Array.isArray(value)) {
    return value.map(formatMetaValue).join(', ');
  }

  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, entry]): string => `${key}: ${formatMetaValue(entry)}`)
      .join(' · ');
  }

  return String(value ?? '');
}

function formatMetaLabel(key: string) {
  const labels: Record<string, string> = {
    tariff: 'Tarifario',
    method: 'Método',
    distanceKm: 'Kilómetros',
    blockSizeKm: 'Tamaño del tramo',
    blocks: 'Tramos',
    ratePerBlock: 'Precio por tramo',
    schedule: 'Horario',
    urgency: 'Urgencia',
    mozoHours: 'Horas de mozo',
    mozoCount: 'Número de mozos',
    ratePerHour: 'Precio por hora',
    ratePerStop: 'Precio por parada',
    additionalStops: 'Paradas adicionales',
    additionalKm: 'Kilómetros adicionales',
    additionalKmPrice: 'Precio por km adicional',
    waitHours: 'Horas de espera',
    rate: 'Tarifa',
    kmRange: 'Tramo km',
    supplement: 'Suplemento',
    unitPrice: 'Precio unitario',
    extraHours: 'Horas extra',
    nightHours: 'Horas nocturnas',
    zone: 'Tramo',
    vehicleType: 'Vehículo',
    temperature: 'Temperatura'
  };

  return labels[key] || key;
}

function formatMetaEntries(meta: Record<string, unknown>) {
  return Object.entries(meta)
    .map(([key, value]) => `${formatMetaLabel(key)}: ${formatMetaValue(value)}`)
    .join(' · ');
}

function buildOperationFormula(line: PricingResult['breakdown'][number]) {
  const meta = line.meta ?? {};
  const amount = currencyFormatter.format(Number(line.amount) || 0);

  if (line.code === 'directo_base') {
    const zone = meta.zone ? `tramo ${formatMetaValue(meta.zone)}` : 'tramo base';
    const distance = meta.distanceKm ? `${formatMetaValue(meta.distanceKm)} km` : 'km informados';
    const additionalKm = Number(meta.additionalKm ?? 0);
    const additionalKmPrice = Number(meta.additionalKmPrice ?? 0);

    if (additionalKm > 0 && additionalKmPrice > 0) {
      return `${zone}: base del tramo + ${formatMetaValue(additionalKm)} km extra × ${currencyFormatter.format(additionalKmPrice)}/km = ${amount}`;
    }

    return `${zone} con ${distance} = ${amount}`;
  }

  if (line.code === 'ultima_milla_base') {
    const quantity = Number(meta.quantity ?? meta.serviceDays ?? 1);
    const unitPrice = Number(meta.unitPrice ?? line.amount ?? 0);
    return `${formatMetaValue(quantity)} servicio(s) × ${currencyFormatter.format(unitPrice)}/servicio = ${amount}`;
  }

  if (line.code === 'ultima_milla_distance') {
    const quantity = Number(meta.quantity ?? 1);
    const unitPrice = Number(meta.unitPrice ?? line.amount ?? 0);
    return `${formatMetaValue(quantity)} recargo(s) × ${currencyFormatter.format(unitPrice)} por ${formatMetaValue(meta.tranche)} = ${amount}`;
  }

  if (line.code === 'districenter_vehicle_25km_blocks') {
    const blocks = Number(meta.blocks ?? 0);
    const rate = Number(meta.ratePerBlock ?? 0);
    const blockSizeKm = Number(meta.blockSizeKm ?? 25);
    const distance = meta.distanceKm ? `${formatMetaValue(meta.distanceKm)} km` : 'km informados';
    return `${distance} / ${blockSizeKm} km = ${blocks} tramos × ${currencyFormatter.format(rate)}/tramo = ${amount}`;
  }

  if (line.code === 'districenter_mozo_hours' || line.code === 'directo_mozo_hours') {
    const hours = Number(meta.mozoHours ?? 0);
    const count = Number(meta.mozoCount ?? 1);
    const rate = Number(meta.ratePerHour ?? 0);
    return `${formatMetaValue(hours)} h × ${count} mozo(s) × ${currencyFormatter.format(rate)}/h = ${amount}`;
  }

  if (line.code === 'directo_mozo_fixed' || line.code === 'directo_mozo_manual') {
    const count = Number(meta.mozoCount ?? 1);
    const unitPrice = Number(meta.unitPrice ?? 0);
    return `${count} mozo(s) × ${currencyFormatter.format(unitPrice)} manual = ${amount}`;
  }

  if (line.code === 'meteor_vehicle_base') {
    const rate = Number(meta.rate ?? line.amount ?? 0);
    return `${formatMetaValue(meta.method)} · ${formatMetaValue(meta.vehicleType)} = ${currencyFormatter.format(rate)}`;
  }

  if (line.code === 'meteor_km_supplement') {
    return `${formatMetaValue(meta.distanceKm)} km · tramo ${formatMetaValue(meta.kmRange)} = ${amount}`;
  }

  if (line.code === 'meteor_mozo_fixed') {
    const count = Number(meta.mozoCount ?? 1);
    const unitPrice = Number(meta.unitPrice ?? 0);
    return `${count} mozo(s) × ${currencyFormatter.format(unitPrice)} fijo = ${amount}`;
  }

  if (line.code === 'meteor_extra_hours' || line.code === 'meteor_night_hours') {
    const hours = Number(meta.extraHours ?? meta.nightHours ?? 0);
    const rate = Number(meta.ratePerHour ?? 0);
    return `${formatMetaValue(hours)} h × ${currencyFormatter.format(rate)}/h = ${amount}`;
  }

  if (line.code === 'directo_additional_stop') {
    const stops = Number(meta.additionalStops ?? 0);
    const rate = Number(meta.ratePerStop ?? 0);
    return `${stops} paradas adicionales × ${currencyFormatter.format(rate)}/parada = ${amount}`;
  }

  if (line.code === 'directo_wait') {
    const waitHours = Number(meta.waitHours ?? 0);
    const rate = Number(meta.ratePerHour ?? 0);
    return `${formatMetaValue(waitHours)} h × ${currencyFormatter.format(rate)}/h = ${amount}`;
  }

  if (line.type === 'surcharge') {
    return `Recargo aplicado según tarifario = ${amount}`;
  }

  if (line.type === 'discount') {
    return `Descuento aplicado según tarifario = ${amount}`;
  }

  return `Importe de línea según criterio del tarifario = ${amount}`;
}

function describePricingModel(value?: string) {
  const key = normalizeText(value);
  if (key === 'recommended_price') {
    return 'Precio recomendado';
  }
  if (key === 'reference_price') {
    return 'Precio de referencia';
  }
  if (key === 'range_plus_recommended') {
    return 'Rango con precio recomendado';
  }
  return value || texts.assistant.noData;
}

function describeDistanceCriterion(analysis: ServiceAnalysis | null) {
  const request = analysis?.pricingRequest;
  const result = analysis?.pricingResult;
  const stops = request?.estimatedStops ?? request?.additionalStops;
  const distanceKm = result?.meta?.distanceKm ?? request?.distanceKm;

  if (request?.family === 'ultima_milla' && stops !== null && stops !== undefined) {
    return `${Number(stops).toLocaleString('es-ES')} paradas × 0,3 km${distanceKm ? ` · ${formatMetaValue(distanceKm)} km totales` : ''}`;
  }

  return result?.workflowRules?.distanceCalculatedFromRoute ? 'ruta/paradas' : 'dato introducido';
}

function buildDetectedPricingCriteria(request: PricingRequest | null) {
  if (!request) {
    return [];
  }

  const assistantTexts = texts.assistant as Record<string, string | undefined>;
  const label = (key: string, fallback: string) => assistantTexts[key] || fallback;
  const criteria: string[] = [];

  if (request.vehicleType) {
    criteria.push(`${label('parameterVehicle', 'Vehículo')}: ${request.vehicleType}`);
  }

  if (request.distanceKm !== null && request.distanceKm !== undefined) {
    criteria.push(`${label('parameterDistance', 'Km reales')}: ${request.distanceKm.toLocaleString('es-ES')} km`);
  }

  if (request.additionalStops !== null && request.additionalStops !== undefined) {
    criteria.push(`${label('parameterAdditionalStops', 'Paradas adicionales')}: ${request.additionalStops}`);
  }

  if (request.loadZone) {
    criteria.push(`${label('parameterLoadZone', 'Zona de carga')}: ${request.loadZone}`);
  }

  if (request.deliveryZone) {
    criteria.push(`${label('parameterDeliveryZone', 'Zona de reparto')}: ${request.deliveryZone}`);
  }

  if (request.serviceDays !== null && request.serviceDays !== undefined) {
    criteria.push(`${label('parameterServiceDays', 'Cantidad de días')}: ${request.serviceDays}`);
  }

  if (!isMeteorPricingRequest(request) && (request.vehicleSchedule || request.schedule)) {
    criteria.push(`${label('parameterVehicleSchedule', 'Jornada vehículo')}: ${formatMetaValue(request.vehicleSchedule || request.schedule)}`);
  }

  if (request.mozoSchedule) {
    criteria.push(`${label('parameterMozoSchedule', 'Jornada mozo')}: ${formatMetaValue(request.mozoSchedule)}`);
  }

  if (request.liftPlatform) {
    criteria.push(`${label('parameterLiftPlatform', 'Plataforma')}: sí`);
  }

  if (request.mozoCount || request.mozoHours) {
    const mozoCount = request.mozoCount ?? 1;
    const mozoHours =
      request.mozoHours !== null && request.mozoHours !== undefined
        ? `${request.mozoHours.toLocaleString('es-ES')} h`
        : label('pendingHours', 'horas pendientes');

    criteria.push(`${label('detectedHelper', 'Mozo/ayudante detectado')}: ${mozoCount} mozo(s) · ${mozoHours}`);
  }

  if (request.temperature) {
    criteria.push(`${label('parameterTemperature', 'Temperatura')}: ${request.temperature}`);
  }

  if (request.tariffName) {
    criteria.push(`${label('selectedTariff', 'Tarifario seleccionado')}: ${request.tariffName}`);
  }

  return criteria;
}

function createDefaultPricingRequest(requestText = ''): PricingRequest {
  const text = normalizeText(requestText);
  return {
    family: text.includes('ultima') || text.includes('reparto') ? 'ultima_milla' : 'directos',
    vehicleType: normalizeVehicleTypeForPricing(text),
    temperature: text.includes('frio') || text.includes('nevera') ? 'refrigerado' : 'seco',
    distanceKm: null,
    weightKg: null,
    additionalStops: null,
    waitHours: null,
    tariffId: null,
    tariffName: null,
    mozoHours: null,
    mozoCount: text.includes('mozo') || text.includes('mosso') ? 1 : null,
    liftPlatform: text.includes('plataforma'),
    roundTrip: false,
    batchedRoute: false,
    notes: null
  };
}

async function calculateWithPricingEngine(pricingRequest: PricingRequest): Promise<PricingResult> {
  let response: Response;
  try {
    response = await fetch('/api/pricing/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pricingRequest)
    });
  } catch {
    throw new Error(texts.assistant.apiUnavailable);
  }

  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.message || error?.error || texts.assistant.pricingUnavailable);
  }

  return response.json();
}

async function calculateDistanceWithMaps(origin: string, destination: string): Promise<MapDistanceResult> {
  const url = `/api/maps/distance?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error(texts.assistant.apiUnavailable);
  }
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.message || texts.assistant.mapsDistanceError);
  }

  const distanceKm = Number(data?.distanceKm);
  if (!Number.isFinite(distanceKm)) {
    throw new Error(texts.assistant.mapsDistanceError);
  }

  return {
    distanceKm,
    distanceText: String(data.distanceText || `${distanceKm} km`),
    durationText: String(data.durationText || ''),
    origin: String(data.origin || origin),
    destination: String(data.destination || destination)
  };
}

async function calculateRouteDistanceWithMaps(addresses: string[], optimize = false): Promise<MapDistanceResult> {
  let response: Response;
  try {
    response = await fetch('/api/maps/route-distance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses, optimize })
    });
  } catch {
    throw new Error(texts.assistant.apiUnavailable);
  }
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.message || texts.assistant.mapsDistanceError);
  }

  const distanceKm = Number(data?.distanceKm);
  if (!Number.isFinite(distanceKm)) {
    throw new Error(texts.assistant.mapsDistanceError);
  }

  return {
    distanceKm,
    distanceText: String(data.distanceText || `${distanceKm} km`),
    durationText: String(data.durationText || ''),
    optimized: Boolean(data.optimized),
    origin: String(data.origin || addresses[0]),
    destination: String(data.destination || addresses[addresses.length - 1]),
    addresses: Array.isArray(data.addresses) ? data.addresses.map((address: unknown) => String(address || '').trim()).filter(Boolean) : addresses
  };
}

async function calculateLastMileDistanceEstimate(loadZone: string, deliveryZone: string, estimatedStops: number) {
  const baseRoute = await calculateRouteDistanceWithMaps([loadZone, deliveryZone, loadZone], false);
  const stopKm = Math.round((estimatedStops * 0.3 + Number.EPSILON) * 10) / 10;
  const distanceKm = Math.round((baseRoute.distanceKm + stopKm + Number.EPSILON) * 10) / 10;

  return {
    ...baseRoute,
    distanceKm,
    estimatedStops,
    stopKm,
    note: `${texts.assistant.lastMileDistanceSource}: ${baseRoute.distanceText} + ${estimatedStops} paradas × 0,3 km = ${distanceKm.toLocaleString('es-ES')} km`
  };
}

async function fetchPlacePredictions(input: string): Promise<PlacePrediction[]> {
  if (input.trim().length < 3) {
    return [];
  }

  let response: Response;
  try {
    response = await fetch(`/api/maps/place-autocomplete?input=${encodeURIComponent(input)}`);
  } catch {
    return [];
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    return [];
  }

  return Array.isArray(data?.predictions)
    ? data.predictions
        .map((prediction: Record<string, unknown>) => ({
          description: String(prediction.description || ''),
          placeId: String(prediction.placeId || ''),
          mainText: String(prediction.mainText || ''),
          secondaryText: String(prediction.secondaryText || '')
        }))
        .filter((prediction: PlacePrediction) => prediction.description && prediction.placeId)
    : [];
}

async function fetchPlaceDetailsAddress(placeId: string, fallback: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`/api/maps/place-details?placeId=${encodeURIComponent(placeId)}`);
  } catch {
    return fallback;
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    return fallback;
  }

  return String(data?.address || fallback).trim() || fallback;
}

function getRouteAddresses(analysis?: LogisticsAnalysis) {
  return (analysis?.ruta ?? [])
    .slice()
    .sort((a, b) => a.orden - b.orden)
    .map((stop) => stop.direccion_normalizada || stop.direccion_original)
    .map((address) => String(address || '').trim())
    .filter(Boolean);
}

const registeredRoutePlaces = [
  {
    officialAddress: 'Carrer del Besòs, 1, Polígon Industrial Can Calopa, 08174 Sant Cugat del Vallès, Barcelona, España',
    match: (value: string) => {
      const normalized = normalizeText(value);
      return (
        (normalized.includes('districenter') && normalized.includes('sant_cugat')) ||
        (normalized.includes('carrer_del_besos') && normalized.includes('can_calopa'))
      );
    }
  }
];

function findRegisteredRoutePlaceAddress(value: string) {
  return registeredRoutePlaces.find((place) => place.match(value))?.officialAddress ?? null;
}

function isRegisteredOfficialRouteAddress(value: string) {
  return registeredRoutePlaces.some((place) => normalizeText(place.officialAddress) === normalizeText(value) || place.match(value));
}

function normalizeRouteCorrectionAddress(value: string, context = '') {
  const address = value.trim().replace(/[.。]+$/g, '').trim();
  const normalized = normalizeText(address);
  const registeredAddress = findRegisteredRoutePlaceAddress(`${address} ${context}`);
  if (registeredAddress) {
    return registeredAddress;
  }

  if (normalized === 'sant_cugat' || normalized === 'san_cugat') {
    return 'Sant Cugat del Vallès, Barcelona, España';
  }

  return address;
}

function looksLikeRouteAddressCandidate(value: string, context = '') {
  const address = value.trim();
  const normalized = normalizeText(address);
  if (!address || address.length < 3) {
    return false;
  }

  if (findRegisteredRoutePlaceAddress(`${address} ${context}`)) {
    return true;
  }

  const instructionWords = [
    'se mantiene',
    'mantiene',
    'tal cual',
    'documentos',
    'albaranes',
    'resto de la ruta',
    'ruta se',
    'calcula',
    'cuenta',
    'contando',
    'todas las direcciones',
    'optimiza'
  ];
  if (instructionWords.some((word) => normalized.includes(normalizeText(word)))) {
    return false;
  }

  const addressSignals = [
    /\b(c\/|calle|carrer|avenida|avinguda|av\.?|pol\.?|poligono|polígono|passeig|plaza|plaça|ronda|camino|carretera)\b/i,
    /\b\d{5}\b/,
    /\b(sant cugat|san cugat|barcelona|tarragona|alcover|arboc|l'arboç|montbrio|coma-ruga|vendrell|sant just)\b/i
  ];

  return addressSignals.some((pattern) => pattern.test(address));
}

function extractForcedRouteOrigin(userText: string) {
  const patterns = [
    /(?:^|\n)\s*(?:origen|primera parada|punto inicial|inicio|salida|recogida inicial|recollida inicial)(?:\s*\([^)]*\))?\s*[:=-]?\s*([^\n.;]+)/i,
    /(?:recogida|origen|salida|inicio|punto inicial|recollida)(?:\s+\w+){0,5}?\s+(?:es|esta|está|seria|sería|empieza|comienza|sale|desde|en)\s+([^.\n,;]+)/i
  ];

  for (const pattern of patterns) {
    const match = userText.match(pattern);
    if (match?.[1] && looksLikeRouteAddressCandidate(match[1], userText)) {
      return normalizeRouteCorrectionAddress(match[1], userText);
    }
  }

  return null;
}

function sameRoutePlace(left: string, right: string) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) {
    return false;
  }

  if (a.includes(b) || b.includes(a)) {
    return true;
  }

  const aliases = [
    ['districenter', 'carrer_del_besos', 'can_calopa', 'sant_cugat'],
    ['sant_cugat', 'sant_cugat_del_valles']
  ];

  return aliases.some((group) => group.some((token) => a.includes(token)) && group.some((token) => b.includes(token)));
}

function applyUserRouteCorrections(addresses: string[], userText: string) {
  const forcedOrigin = extractForcedRouteOrigin(userText);
  if (!forcedOrigin) {
    return addresses;
  }

  const cleanedAddresses = addresses.map((address) => address.trim()).filter(Boolean);
  if (cleanedAddresses[0] && sameRoutePlace(cleanedAddresses[0], forcedOrigin)) {
    if (isRegisteredOfficialRouteAddress(forcedOrigin) && !isRegisteredOfficialRouteAddress(cleanedAddresses[0])) {
      return [forcedOrigin, ...cleanedAddresses.slice(1)];
    }

    return cleanedAddresses;
  }

  const existingIndex = cleanedAddresses.findIndex((address) => sameRoutePlace(address, forcedOrigin));
  if (existingIndex >= 0) {
    return [
      forcedOrigin,
      ...cleanedAddresses.slice(0, existingIndex),
      ...cleanedAddresses.slice(existingIndex + 1)
    ];
  }

  return [forcedOrigin, ...cleanedAddresses];
}

function shouldOptimizeRouteFromText(userText: string) {
  const normalized = normalizeText(userText);

  if (/contando todas|todas las direcciones|orden operativo|sin optimizar|mismo orden/.test(normalized)) {
    return false;
  }

  return /ruta optima|ruta optimo|optimiza|optimizar|optimizada|menor distancia/.test(normalized);
}

function hasRouteInstruction(userText: string) {
  return /distancia|kil[oó]metros?|km|ruta|trayecto|direcci[oó]n|direcciones|origen|destino|recogida|entrega|salida|inicio|contando todas|todas las direcciones|optimiza/i.test(userText);
}

function extractConfirmedDistanceKm(userText: string) {
  const matches = [...userText.matchAll(/(\d{2,4}(?:[,.]\d{1,2})?)\s*(?:km|kilometros|kilómetros)\b/gi)];
  if (matches.length === 0) {
    return null;
  }

  const values = matches
    .map((match) => Number(match[1].replace(',', '.')))
    .filter((value) => Number.isFinite(value) && value > 0);

  return values.length > 0 ? values[values.length - 1] : null;
}

function inferOperationalSurchargesFromText(userText: string, current?: PricingRequest['operationalSurcharges']) {
  const normalized = normalizeText(userText);
  const next = { ...(current ?? {}) };

  const mentionsShortNotice =
    /\b(hoy|manana|24h|24\s*h|menos[\s_]+de[\s_]+24\s*h?|menos[\s_]+de[\s_]+un[\s_]+dia|para[\s_]+manana)\b/.test(normalized) ||
    (normalized.includes('urgente') && normalized.includes('manana'));
  const mentionsLessThan48h =
    mentionsShortNotice ||
    /\b(48h|48\s*h|menos[\s_]+de[\s_]+48\s*h?|pasado[\s_]+manana|dos[\s_]+dias|2[\s_]+dias)\b/.test(normalized);

  if (mentionsShortNotice) {
    next.requestLessThan24h = true;
    next.requestLessThan48h = false;
  } else if (mentionsLessThan48h && next.requestLessThan24h !== true) {
    next.requestLessThan48h = true;
  }

  return Object.keys(next).length > 0 ? next : current ?? null;
}

function cleanLiteralUrgencyModalities(modality?: string[] | null) {
  const modalities = Array.isArray(modality) ? modality : [];
  const literalUrgencyKeys = ['urgente', 'urgent', 'prioritario', 'priority'];
  const cleaned = modalities.filter((item) => !literalUrgencyKeys.some((key) => normalizeText(item).includes(key)));
  return cleaned.length > 0 ? cleaned : null;
}

type MozoRequirement = 'none' | 'manual_price' | 'hours' | 'fixed_count';

function isMeteorPricingRequest(request?: PricingRequest | null) {
  const tariffKey = normalizeText(`${request?.tariffId || ''} ${request?.tariffName || ''}`);
  return tariffKey.includes('meteor');
}

function getMozoRequirement(request?: PricingRequest | null): MozoRequirement {
  if (!request) {
    return 'none';
  }

  const tariffKey = normalizeText(`${request.tariffId || ''} ${request.tariffName || ''}`);
  if (tariffKey.includes('districenter')) {
    return 'hours';
  }
  if (tariffKey.includes('meteor')) {
    return 'fixed_count';
  }
  if (tariffKey.includes('onus') || tariffKey.includes('express')) {
    return 'manual_price';
  }
  return 'none';
}

function pricingRequestNeedsMozoHours(request?: PricingRequest | null) {
  if (!request) {
    return false;
  }

  if (getMozoRequirement(request) !== 'hours') {
    return false;
  }

  const mozoCount = Number(request.mozoCount ?? 0);
  const mozoHours = Number(request.mozoHours ?? 0);
  return Number.isFinite(mozoCount) && mozoCount > 0 && (!Number.isFinite(mozoHours) || mozoHours <= 0);
}

function pricingRequestNeedsManualMozoPrice(request?: PricingRequest | null) {
  if (!request || getMozoRequirement(request) !== 'manual_price') {
    return false;
  }

  const mozoCount = Number(request.mozoCount ?? 0);
  const mozoManualPrice = Number(request.mozoManualPrice ?? 0);
  return Number.isFinite(mozoCount) && mozoCount > 0 && (!Number.isFinite(mozoManualPrice) || mozoManualPrice <= 0);
}

function normalizeHelperFromRequest(request: PricingRequest): PricingRequest {
  const modalities = Array.isArray(request.modality) ? request.modality : [];
  const helperModalities = ['ayudante', 'mozo', 'mosso', 'helper'];
  const hasHelper = modalities.some((modality) => helperModalities.some((helper) => normalizeText(modality).includes(helper)));
  const cleanedModalities = modalities.filter((modality) => !helperModalities.some((helper) => normalizeText(modality).includes(helper)));

  return {
    ...request,
    modality: cleanedModalities.length > 0 ? cleanedModalities : null,
    mozoCount: hasHelper ? request.mozoCount ?? 1 : request.mozoCount
  };
}

function ensurePricingMissingData(missingData: string[], request?: PricingRequest | null) {
  const labelMap: Record<string, string> = {
    weightKg: 'Peso',
    volume: 'Volumen',
    numberOfPackages: 'Número de bultos',
    dimensions: 'Dimensiones',
    serviceDays: 'Cantidad de días'
  };
  const seenMissing = new Set<string>();
  const nextMissingData = missingData
    .map((item) => labelMap[item] || item)
    .filter((item) => {
      const normalized = normalizeText(item);
      const isServiceDaysMissing = normalized.includes('cantidad') && normalized.includes('dias');
      if (!normalized) {
        return false;
      }
      if (isServiceDaysMissing && request?.serviceDays) {
        return false;
      }
      if (isMeteorPricingRequest(request) && normalized.includes('jornada') && normalized.includes('vehiculo')) {
        return false;
      }
      if (normalized.includes('horas') && normalized.includes('mozo') && !pricingRequestNeedsMozoHours(request)) {
        return false;
      }
      const isManualMozoPriceMissing = normalized.includes('precio') && normalized.includes('mozo');
      if (isManualMozoPriceMissing && !pricingRequestNeedsManualMozoPrice(request)) {
        return false;
      }
      const key = normalized.includes('horas') && normalized.includes('mozo') ? 'horas_mozo' : isManualMozoPriceMissing ? 'precio_mozo' : isServiceDaysMissing ? 'cantidad_de_dias' : normalized;
      if (seenMissing.has(key)) {
        return false;
      }
      seenMissing.add(key);
      return true;
    });
  if (pricingRequestNeedsMozoHours(request) && !seenMissing.has('horas_mozo')) {
    nextMissingData.push('Horas mozo');
    seenMissing.add('horas_mozo');
  }
  if (pricingRequestNeedsManualMozoPrice(request) && !seenMissing.has('precio_mozo')) {
    nextMissingData.push('Importe mozo/ayudante (€)');
    seenMissing.add('precio_mozo');
  }
  if (request?.family === 'ultima_milla' && !request.serviceDays && !seenMissing.has('cantidad_de_dias')) {
    nextMissingData.push('Cantidad de días');
  }
  return nextMissingData;
}

function applyUserTextToPricingRequest(request: PricingRequest, userText: string, catalog?: Catalog): PricingRequest {
  const text = userText.trim();
  if (!text) {
    return request;
  }

  const normalizedText = normalizeText(text);
  const routeAddresses = applyUserRouteCorrections(
    (request.routeAddresses?.length ? request.routeAddresses : [request.originAddress, request.destinationAddress])
      .map((address) => String(address || '').trim())
      .filter(Boolean),
    text
  );
  const confirmedDistanceKm = extractConfirmedDistanceKm(text);
  const routeOptimization = shouldOptimizeRouteFromText(text) && !request.routeHasTimeConstraints;
  const needsMozo = normalizedText.includes('mozo') || normalizedText.includes('mosso') || normalizedText.includes('ayudante');
  const mentionsPlatform = normalizedText.includes('plataforma');
  const mentionsCold = normalizedText.includes('frio') || normalizedText.includes('frigor') || normalizedText.includes('refriger');
  const mentionsFrozen = normalizedText.includes('congel');
  const operationalSurcharges = inferOperationalSurchargesFromText(text, request.operationalSurcharges);
  const notes = [
    request.notes,
    `${texts.assistant.userInstructionsApplied}: ${text}`
  ]
    .filter(Boolean)
    .join('\n');

  return {
    ...normalizeHelperFromRequest(request),
    routeAddresses: routeAddresses.length >= 2 ? routeAddresses : request.routeAddresses,
    originAddress: routeAddresses[0] ?? request.originAddress,
    destinationAddress: routeAddresses.length >= 2 ? routeAddresses[routeAddresses.length - 1] : request.destinationAddress,
    additionalStops: routeAddresses.length >= 2 ? Math.max(0, routeAddresses.length - 2) : request.additionalStops,
    routeOptimization,
    distanceKm: confirmedDistanceKm ?? request.distanceKm,
    mozoCount: needsMozo ? request.mozoCount ?? 1 : normalizeHelperFromRequest(request).mozoCount,
    modality: cleanLiteralUrgencyModalities(normalizeHelperFromRequest(request).modality),
    operationalSurcharges,
    liftPlatform: mentionsPlatform || request.liftPlatform,
    temperature: mentionsFrozen ? 'congelado' : mentionsCold ? 'refrigerado' : request.temperature,
    vehicleType: resolveVehicleForCatalog(request, catalog, text),
    notes
  };
}

function retargetPricingRequestToCatalog(request: PricingRequest, catalog: Catalog, userText = ''): PricingRequest {
  const sourceText = [request.vehicleType, userText, request.notes].filter(Boolean).join('\n');
  const normalizedRequest = normalizeHelperFromRequest(request);
  const requestForCatalog = { ...normalizedRequest, tariffId: catalog.id, tariffName: catalog.name };
  const isMeteorCatalog = normalizeText(`${catalog.id} ${catalog.name}`).includes('meteor');

  return {
    ...requestForCatalog,
    tariffId: catalog.id,
    tariffName: catalog.name,
    vehicleType: resolveVehicleForCatalog(requestForCatalog, catalog, sourceText),
    schedule: isMeteorCatalog ? null : requestForCatalog.schedule,
    vehicleSchedule: isMeteorCatalog ? null : requestForCatalog.vehicleSchedule
  };
}

async function preparePricingRequestForCalculation(request: PricingRequest, userText: string, catalog: Catalog): Promise<PricingRequest> {
  let prepared = applyUserTextToPricingRequest(retargetPricingRequestToCatalog(request, catalog, userText), userText, catalog);
  const allowedVehicles = getVehicleOptionsForCatalog(catalog.id || catalog.name, prepared.family, prepared.temperature);
  if (prepared.vehicleType && !findAllowedVehicle(prepared.vehicleType, allowedVehicles)) {
    prepared = { ...prepared, vehicleType: null };
  }
  const text = userText.trim();
  const addresses = (prepared.routeAddresses?.length ? prepared.routeAddresses : [prepared.originAddress, prepared.destinationAddress])
    .map((address) => String(address || '').trim())
    .filter(Boolean);
  const confirmedDistanceKm = extractConfirmedDistanceKm(text);
  const isLastMile = prepared.family === 'ultima_milla';
  const loadZone = String(prepared.loadZone || '').trim();
  const deliveryZone = String(prepared.deliveryZone || '').trim();

  if (isLastMile && loadZone && deliveryZone && !confirmedDistanceKm) {
    const estimatedStops = Math.max(0, Number(prepared.estimatedStops ?? prepared.additionalStops ?? 0));
    const distance = await calculateLastMileDistanceEstimate(loadZone, deliveryZone, estimatedStops);
    prepared = {
      ...prepared,
      distanceKm: distance.distanceKm,
      originAddress: loadZone,
      destinationAddress: deliveryZone,
      routeAddresses: [loadZone, deliveryZone, loadZone],
      additionalStops: estimatedStops,
      notes: [prepared.notes, distance.note].filter(Boolean).join('\n')
    };
  }

  if (!isLastMile && addresses.length >= 2 && !confirmedDistanceKm && (hasRouteInstruction(text) || prepared.distanceKm === null || prepared.distanceKm === undefined)) {
    const distance = await calculateRouteDistanceWithMaps(addresses, Boolean(prepared.routeOptimization) && !prepared.routeHasTimeConstraints);
    const calculatedRouteAddresses = distance.addresses ?? addresses;
    prepared = {
      ...prepared,
      distanceKm: distance.distanceKm,
      originAddress: distance.origin,
      destinationAddress: distance.destination,
      routeAddresses: calculatedRouteAddresses,
      additionalStops: Math.max(0, calculatedRouteAddresses.length - 2),
      routeOptimization: Boolean(prepared.routeOptimization) && !prepared.routeHasTimeConstraints,
      notes: [
        prepared.notes,
        `${texts.assistant.mapsDistanceSource}: ${distance.distanceText}${distance.durationText ? ` · ${distance.durationText}` : ''}${distance.optimized ? ` · ${texts.assistant.optimizedRoute}` : ''}`
      ]
        .filter(Boolean)
        .join('\n')
    };
  }

  return prepared;
}

function hasRouteTimeConstraints(analysis?: LogisticsAnalysis) {
  return Boolean(
    analysis?.ruta?.some((stop) => {
      const from = String(stop.horario_desde || '').trim();
      const to = String(stop.horario_hasta || '').trim();
      return Boolean(from || to);
    })
  );
}

function inferPricingRequestFromLogistics(analysis: LogisticsAnalysis, baseText: string, catalog?: Catalog): PricingRequest {
  const routeAddresses = applyUserRouteCorrections(getRouteAddresses(analysis), baseText);
  const resources = (analysis.carga?.recursos_necesarios ?? []).join(' ');
  const combinedText = `${baseText}\n${analysis.servicio?.resumen || ''}\n${analysis.carga?.vehiculo_recomendado || ''}\n${resources}`;
  const request = createDefaultPricingRequest(combinedText);
  const confirmedWeight = analysis.carga?.peso_confirmado_kg;
  const confirmedDistanceKm = extractConfirmedDistanceKm(baseText);
  const normalizedCombinedText = normalizeText(`${resources}\n${combinedText}`);
  const needsMozo = normalizedCombinedText.includes('mozo') || normalizedCombinedText.includes('mosso') || normalizedCombinedText.includes('ayudante');

  const inferredRequest = {
    ...request,
    family: normalizeText(analysis.servicio?.tipo).includes('ultima') ? 'ultima_milla' : request.family,
    originAddress: routeAddresses[0] ?? null,
    destinationAddress: routeAddresses[routeAddresses.length - 1] ?? null,
    routeAddresses,
    routeHasTimeConstraints: hasRouteTimeConstraints(analysis),
    routeOptimization: shouldOptimizeRouteFromText(baseText) && !hasRouteTimeConstraints(analysis),
    distanceKm: confirmedDistanceKm ?? analysis.servicio?.distancia_km ?? null,
    weightKg: typeof confirmedWeight === 'number' ? confirmedWeight : null,
    mozoHours: needsMozo && typeof analysis.servicio?.duracion_horas === 'number' ? analysis.servicio.duracion_horas : request.mozoHours,
    mozoCount: needsMozo ? 1 : request.mozoCount,
    additionalStops: Math.max(0, routeAddresses.length - 2),
    liftPlatform: normalizeText(resources).includes('plataforma') || request.liftPlatform,
    vehicleType: request.vehicleType,
    notes: [
      routeAddresses.length > 1 ? `${texts.assistant.mapsRouteStops}: ${routeAddresses.length}` : null,
      confirmedDistanceKm ? `${texts.assistant.userConfirmedDistance}: ${confirmedDistanceKm.toLocaleString('es-ES')} km` : null
    ]
      .filter(Boolean)
      .join('\n') || null
  };

  return {
    ...inferredRequest,
    vehicleType: resolveVehicleForCatalog(inferredRequest, catalog, `${analysis.carga?.vehiculo_recomendado || ''}\n${combinedText}`)
  };
}

async function analyzeWithAi(requestText: string, catalog: Catalog, clientName: string): Promise<ServiceAnalysis> {
  let response: Response;
  try {
    response = await fetch('/api/analyze-service', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestText, catalog, clientName })
    });
  } catch {
    throw new Error(texts.assistant.apiUnavailable);
  }

  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || 'AI analysis failed');
  }

  const analysis = await response.json();
  return {
    request: analysis.requestData?.serviceDescription || requestText,
    catalogName: catalog.name,
    clientName,
    summary: analysis.summary || '',
    assumptions: analysis.requestData?.assumptions ?? [],
    missingData: analysis.requestData?.missingData ?? [],
    candidateServices: (analysis.candidateServices ?? []).map((candidate: { itemName: string; reason: string }) =>
      candidate.reason ? `${candidate.itemName}: ${candidate.reason}` : candidate.itemName
    ),
    aiCandidateLines: pricingResultToQuoteLines(analysis.pricingResult),
    pricingRequest: analysis.pricingRequest ?? null,
    pricingResult: analysis.pricingResult
  };
}

function App() {
  const data = defaultData;
  const [accessUsers, setAccessUsers] = useState<LoginSession[]>(() => loadAccessUsersFromStorage());
  const [loginSession, setLoginSession] = useState<LoginSession | null>(null);
  const [loginClient, setLoginClient] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isAdminPanelOpen, setIsAdminPanelOpen] = useState(false);
  const [isSupabaseReady, setIsSupabaseReady] = useState(false);
  const [adminSaveStatus, setAdminSaveStatus] = useState('');
  const [selectedCatalogId, setSelectedCatalogId] = useState(data.catalogs[0].id);
  const [clientName, setClientName] = useState('');
  const [assistantText, setAssistantText] = useState<string>(texts.assistant.initialMessage);
  const [inputText, setInputText] = useState('');
  const [attachedDocuments, setAttachedDocuments] = useState<AnalyzableDocument[]>([]);
  const [quoteLines, setQuoteLines] = useState<QuoteLine[]>([]);
  const [serviceAnalysis, setServiceAnalysis] = useState<ServiceAnalysis | null>(null);
  const [editablePricingRequest, setEditablePricingRequest] = useState<PricingRequest | null>(null);
  const [isAnalysisApproved, setIsAnalysisApproved] = useState(false);
  const [thinkingState, setThinkingState] = useState<ThinkingState>('idle');
  const [isListening, setIsListening] = useState(false);
  const assistantFileInputRef = useRef<HTMLInputElement>(null);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceBaseTextRef = useRef('');

  useEffect(() => {
    return () => {
      speechRecognitionRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    fetchSupabaseStatus()
      .then(async (configured) => {
        if (!isMounted) {
          return;
        }

        setIsSupabaseReady(configured);
        if (configured) {
          const users = await fetchAccessUsersFromApi();
          if (isMounted && users.length > 0) {
            setAccessUsers(users);
          }
        }
      })
      .catch(() => {
        if (isMounted) {
          setIsSupabaseReady(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isSupabaseReady) {
      saveAccessUsersToStorage(accessUsers);
    }
  }, [accessUsers, isSupabaseReady]);

  useEffect(() => {
    if (!loginSession) {
      return;
    }

    const currentUser = accessUsers.find((user) => user.clientId === loginSession.clientId);
    if (!currentUser?.isActive) {
      handleLogout();
      return;
    }

    if (
      currentUser.clientName !== loginSession.clientName ||
      currentUser.code !== loginSession.code ||
      currentUser.role !== loginSession.role ||
      currentUser.allowedCatalogIds.join('|') !== loginSession.allowedCatalogIds.join('|')
    ) {
      setLoginSession(currentUser);
      if (currentUser.role !== 'admin') {
        setClientName(currentUser.clientName);
      }
    }
  }, [accessUsers, loginSession]);

  const availableCatalogs = useMemo(
    () => data.catalogs.filter((catalog) => isCatalogAllowedForSession(catalog, loginSession)),
    [data.catalogs, loginSession]
  );

  useEffect(() => {
    if (!loginSession || availableCatalogs.length === 0) {
      return;
    }

    if (!availableCatalogs.some((catalog) => catalog.id === selectedCatalogId)) {
      setSelectedCatalogId(availableCatalogs[0].id);
    }
  }, [availableCatalogs, loginSession, selectedCatalogId]);

  useEffect(() => {
    if (!serviceAnalysis?.pricingResult) {
      setQuoteLines([]);
    }
  }, [serviceAnalysis?.pricingResult]);

  useEffect(() => {
    if (!serviceAnalysis) {
      setEditablePricingRequest(null);
      return;
    }

    setEditablePricingRequest(serviceAnalysis.pricingRequest ? { ...serviceAnalysis.pricingRequest } : createDefaultPricingRequest(serviceAnalysis.request));
  }, [serviceAnalysis]);

  const selectedCatalog = useMemo(
    () => availableCatalogs.find((catalog) => catalog.id === selectedCatalogId) ?? availableCatalogs[0] ?? data.catalogs[0],
    [availableCatalogs, data.catalogs, selectedCatalogId]
  );
  const vehicleOptionIndex = useMemo(() => buildVehicleOptionIndex(data.catalogs), [data.catalogs]);

  const effectiveClientName = clientName.trim() || texts.system.defaultClient;
  const isThinking = thinkingState !== 'idle';
  const hasRequestContent = Boolean(inputText.trim() || attachedDocuments.length);
  const thinkingText =
    thinkingState === 'documents'
      ? texts.assistant.thinkingDocuments
      : thinkingState === 'analysis'
        ? texts.assistant.thinkingAnalysis
        : thinkingState === 'pricing'
          ? texts.assistant.thinkingPricing
          : '';

  const handleCatalogChange = (catalogId: string) => {
    const nextCatalog = availableCatalogs.find((catalog) => catalog.id === catalogId) ?? availableCatalogs[0] ?? selectedCatalog;
    if (!nextCatalog) {
      return;
    }

    setSelectedCatalogId(nextCatalog.id);
    setQuoteLines([]);
    setIsAnalysisApproved(false);
    setEditablePricingRequest((current) =>
      current ? retargetPricingRequestToCatalog(current, nextCatalog, inputText) : current
    );
    setServiceAnalysis((current) => {
      if (!current) {
        return current;
      }

      const currentRequest = editablePricingRequest ?? current.pricingRequest ?? createDefaultPricingRequest(current.request);
      const retargetedRequest = retargetPricingRequestToCatalog(currentRequest, nextCatalog, inputText);

      return {
        ...current,
        catalogName: nextCatalog.name,
        pricingRequest: retargetedRequest,
        pricingResult: undefined,
        aiCandidateLines: []
      };
    });
    setAssistantText(texts.assistant.catalogChanged);
  };

  const handleLoginSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const applySession = (session: LoginSession) => {
      const firstCatalog = session.allowedCatalogIds.includes('*')
        ? data.catalogs[0]
        : data.catalogs.find((catalog) => session.allowedCatalogIds.includes(catalog.id)) ?? data.catalogs[0];

      setLoginSession(session);
      setClientName(session.role === 'admin' ? '' : session.clientName);
      setSelectedCatalogId(firstCatalog.id);
      setLoginError('');
      setAssistantText(texts.assistant.initialMessage);
    };

    if (isSupabaseReady) {
      loginWithSupabase(loginClient, loginCode)
        .then(applySession)
        .catch((error) => setLoginError(error instanceof Error ? error.message : texts.login.error));
      return;
    }

    const session = resolveLoginSession(loginClient, loginCode, accessUsers);
    if (!session) {
      setLoginError(texts.login.error);
      return;
    }

    applySession(session);
  };

  const handleLogout = () => {
    speechRecognitionRef.current?.stop();
    setLoginSession(null);
    setIsAdminPanelOpen(false);
    setLoginCode('');
    setLoginError('');
    setSelectedCatalogId(defaultData.catalogs[0].id);
    setClientName('');
    setInputText('');
    setAttachedDocuments([]);
    setQuoteLines([]);
    setServiceAnalysis(null);
    setEditablePricingRequest(null);
    setIsAnalysisApproved(false);
    setIsListening(false);
    setThinkingState('idle');
    setAssistantText(texts.assistant.initialMessage);
  };

  const handleAccessUsersChange = (users: LoginSession[]) => {
    setAccessUsers(users);
    setAdminSaveStatus(isSupabaseReady ? '' : texts.admin.localNotice);
  };

  const handleSaveAccessUsers = async () => {
    if (!isSupabaseReady) {
      setAdminSaveStatus(texts.admin.localNotice);
      return;
    }

    try {
      const storedUsers = await saveAccessUsersToApi(accessUsers);
      setAccessUsers(storedUsers);
      setAdminSaveStatus(texts.admin.saved);
    } catch (error) {
      setAdminSaveStatus(error instanceof Error ? error.message : texts.admin.saveError);
    }
  };

  const handleProcessRequest = async () => {
    const text = inputText.trim();

    if (!hasRequestContent || isThinking) {
      return;
    }

    setThinkingState('analysis');
    setAssistantText(texts.assistant.aiAnalyzing);

    try {
      let inferredPricingRequest: PricingRequest | null = null;
      const userConfirmedDistanceKm = extractConfirmedDistanceKm(text);
      const preparedAttachedDocuments = attachedDocuments.length > 0 ? await prepareAttachedDocumentsForAnalysis(attachedDocuments) : [];
      const documentsForAnalysis = [
        ...(text
          ? [
              {
                id: 'user-instructions',
                fileName: texts.assistant.userInstructionsDocumentName,
                text
              }
            ]
          : []),
        ...preparedAttachedDocuments
      ];
      let requestForAnalysis = text;
      if (attachedDocuments.length > 0) {
        try {
          const documentAnalysis = await analyzeDocumentsWithAi(documentsForAnalysis, selectedCatalog, effectiveClientName);
          requestForAnalysis = [text, documentAnalysis.formattedText].filter(Boolean).join('\n\n');
          inferredPricingRequest = inferPricingRequestFromLogistics(documentAnalysis.analysis, requestForAnalysis, selectedCatalog);

          const routeAddresses = applyUserRouteCorrections(getRouteAddresses(documentAnalysis.analysis), text);
          if (routeAddresses.length >= 2 && !userConfirmedDistanceKm) {
            try {
              const routeHasTimeConstraints = hasRouteTimeConstraints(documentAnalysis.analysis);
              const routeOptimization = shouldOptimizeRouteFromText(text) && !routeHasTimeConstraints;
              const routeDistance = await calculateRouteDistanceWithMaps(routeAddresses, routeOptimization);
              const calculatedRouteAddresses = routeDistance.addresses ?? routeAddresses;
              inferredPricingRequest = {
                ...inferredPricingRequest,
                distanceKm: routeDistance.distanceKm,
                originAddress: routeDistance.origin,
                destinationAddress: routeDistance.destination,
                routeAddresses: calculatedRouteAddresses,
                routeHasTimeConstraints,
                routeOptimization,
                additionalStops: Math.max(0, calculatedRouteAddresses.length - 2),
                notes: [
                  inferredPricingRequest.notes,
                  `${texts.assistant.mapsDistanceSource}: ${routeDistance.distanceText}${routeDistance.durationText ? ` · ${routeDistance.durationText}` : ''}${routeDistance.optimized ? ` · ${texts.assistant.optimizedRoute}` : ''}`
                ]
                  .filter(Boolean)
                  .join('\n')
              };
            } catch (mapsError) {
              inferredPricingRequest = {
                ...inferredPricingRequest,
                notes: [
                  inferredPricingRequest.notes,
                  mapsError instanceof Error ? mapsError.message : texts.assistant.mapsDistanceError
                ]
                  .filter(Boolean)
                  .join('\n')
              };
            }
          }
          if (routeAddresses.length >= 2 && userConfirmedDistanceKm) {
            inferredPricingRequest = {
              ...inferredPricingRequest,
              distanceKm: userConfirmedDistanceKm,
              routeAddresses,
              additionalStops: Math.max(0, routeAddresses.length - 2),
              notes: [
                inferredPricingRequest.notes,
                `${texts.assistant.userConfirmedDistance}: ${userConfirmedDistanceKm.toLocaleString('es-ES')} km`
              ]
                .filter(Boolean)
                .join('\n')
            };
          }
        } catch (error) {
          requestForAnalysis = [
            text,
            error instanceof Error ? error.message : texts.assistant.aiUnavailable,
            texts.assistant.documentRequiresAi,
            buildLocalDocumentSummary(documentsForAnalysis)
          ]
            .filter(Boolean)
          .join('\n\n');
        }
      }

      const analyzed = await analyzeWithAi(requestForAnalysis, selectedCatalog, effectiveClientName);
      const mergedPricingRequest = {
        ...(analyzed.pricingRequest ?? createDefaultPricingRequest(requestForAnalysis)),
        ...(inferredPricingRequest ?? {})
      };
      const prioritizedPricingRequest = applyUserTextToPricingRequest(
        {
          ...mergedPricingRequest,
          vehicleType: resolveVehicleForCatalog(
            { ...mergedPricingRequest, tariffId: selectedCatalog.id, tariffName: selectedCatalog.name },
            selectedCatalog,
            mergedPricingRequest.vehicleType || requestForAnalysis
          ),
          tariffId: selectedCatalog.id,
          tariffName: selectedCatalog.name
        },
        text,
        selectedCatalog
      );
      setServiceAnalysis({
        ...analyzed,
        catalogName: selectedCatalog.name,
        clientName: effectiveClientName,
        missingData: ensurePricingMissingData(analyzed.missingData, prioritizedPricingRequest),
        pricingRequest: prioritizedPricingRequest
      });
    } catch (error) {
      setServiceAnalysis({
        request: text || texts.assistant.attachedDocumentsFallback,
        catalogName: selectedCatalog.name,
        clientName: effectiveClientName,
        summary: error instanceof Error ? error.message : texts.assistant.aiUnavailable,
        assumptions: [],
        missingData: [texts.assistant.aiUnavailable],
        candidateServices: []
      });
    } finally {
      setQuoteLines([]);
      setIsAnalysisApproved(false);
      setAssistantText(texts.assistant.analysisReady);
      setThinkingState('idle');
    }
  };

  const handleApproveAnalysis = () => {
    setIsAnalysisApproved(true);
    setAssistantText(texts.assistant.analysisApproved);
  };

  const handlePricingRequestChange = (request: PricingRequest | null) => {
    setEditablePricingRequest(request);
    setQuoteLines([]);
    setIsAnalysisApproved(false);
    setServiceAnalysis((current) =>
      current
        ? {
            ...current,
            pricingRequest: request,
            pricingResult: undefined,
            aiCandidateLines: [],
            missingData: ensurePricingMissingData(current.missingData, request)
          }
        : current
    );
    setAssistantText(texts.assistant.parametersChanged);
  };

  const handleTariffRequest = async () => {
    if (!hasRequestContent || !serviceAnalysis || !isAnalysisApproved || isThinking) {
      setAssistantText(texts.assistant.analysisRequired);
      return;
    }

    setThinkingState('pricing');
    setAssistantText(texts.assistant.thinkingPricing);

    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const requestForCalculation = editablePricingRequest
        ? await preparePricingRequestForCalculation(
            { ...editablePricingRequest, tariffId: selectedCatalog.id, tariffName: selectedCatalog.name },
            inputText,
            selectedCatalog
          )
        : null;
      if (requestForCalculation) {
        setEditablePricingRequest(requestForCalculation);
      }
      if (pricingRequestNeedsMozoHours(requestForCalculation)) {
        setServiceAnalysis((current) =>
          current
            ? {
                ...current,
                missingData: ensurePricingMissingData(current.missingData, requestForCalculation),
                pricingRequest: requestForCalculation
              }
            : current
        );
        setQuoteLines([]);
        setAssistantText('Mozo detectado. Completa las horas de mozo para incluirlo en la tarifa.');
        return;
      }
      if (pricingRequestNeedsManualMozoPrice(requestForCalculation)) {
        setServiceAnalysis((current) =>
          current
            ? {
                ...current,
                missingData: ensurePricingMissingData(current.missingData, requestForCalculation),
                pricingRequest: requestForCalculation
              }
            : current
        );
        setQuoteLines([]);
        setAssistantText('Mozo/ayudante detectado. Indica el importe en euros para incluirlo en la tarifa.');
        return;
      }
      const pricingResult = requestForCalculation
        ? await calculateWithPricingEngine(requestForCalculation)
        : serviceAnalysis.pricingResult;
      const calculatedLines = pricingResultToQuoteLines(pricingResult);
      if (calculatedLines.length === 0) {
        setQuoteLines([]);
        setAssistantText(texts.assistant.pricingUnavailable);
        return;
      }

      setServiceAnalysis((current) =>
        current
          ? {
              ...current,
              catalogName: selectedCatalog.name,
              clientName: effectiveClientName,
              pricingRequest: requestForCalculation ?? current.pricingRequest,
              pricingResult,
              aiCandidateLines: calculatedLines,
              missingData: []
            }
          : current
      );
      setQuoteLines(calculatedLines);
      setAssistantText(texts.assistant.proposalReady.replace('{client}', effectiveClientName));
    } catch (error) {
      setQuoteLines([]);
      setAssistantText(error instanceof Error ? error.message : texts.assistant.pricingUnavailable);
    } finally {
      setThinkingState('idle');
    }
  };

  const addAttachedFiles = (files: File[], source: 'upload' | 'paste') => {
    if (files.length === 0 || isThinking) {
      return;
    }

    const documents = files.map((file, index) => {
      const extension = file.type === 'image/png' ? 'png' : file.type === 'image/jpeg' ? 'jpg' : '';
      const fallbackName =
        source === 'paste' && isImageFile(file)
          ? `imagen-pegada-${new Date().toISOString().replace(/[:.]/g, '-')}-${index + 1}${extension ? `.${extension}` : ''}`
          : `documento-${index + 1}`;

      return {
        id: createId('document'),
        fileName: file.name || fallbackName,
        text: '',
        mimeType: file.type,
        size: file.size,
        file
      };
    });

    setAttachedDocuments((current) => [...current, ...documents]);
    setQuoteLines([]);
    setServiceAnalysis(null);
    setIsAnalysisApproved(false);
    setAssistantText(texts.assistant.documentsAttached.replace('{count}', String(documents.length)));
  };

  const handleAssistantDocumentUpload = (event: ChangeEvent<HTMLInputElement>) => {
    addAttachedFiles(Array.from(event.target.files ?? []), 'upload');
    event.target.value = '';
  };

  const handleInstructionPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (isThinking) {
      return;
    }

    const imageFiles = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file' && (item.type === 'image/png' || item.type === 'image/jpeg'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    addAttachedFiles(imageFiles, 'paste');
  };

  const handleRemoveAttachedDocument = (documentId: string) => {
    setAttachedDocuments((current) => current.filter((document) => document.id !== documentId));
    setServiceAnalysis(null);
    setQuoteLines([]);
    setIsAnalysisApproved(false);
  };

  const handleResetData = () => {
    speechRecognitionRef.current?.stop();
    setSelectedCatalogId(availableCatalogs[0]?.id ?? defaultData.catalogs[0].id);
    setClientName(loginSession?.role === 'admin' ? '' : loginSession?.clientName ?? '');
    setInputText('');
    setAttachedDocuments([]);
    setQuoteLines([]);
    setServiceAnalysis(null);
    setEditablePricingRequest(null);
    setIsAnalysisApproved(false);
    setThinkingState('idle');
    setIsListening(false);
    setAssistantText(texts.system.restored);
  };

  const handleVoiceInput = () => {
    if (isThinking) {
      return;
    }

    if (isListening) {
      speechRecognitionRef.current?.stop();
      setIsListening(false);
      setAssistantText(texts.assistant.voiceStopped);
      return;
    }

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setAssistantText(texts.assistant.voiceUnsupported);
      return;
    }

    const recognition = new Recognition();
    speechRecognitionRef.current = recognition;
    recognition.lang = 'es-ES';
    recognition.continuous = true;
    recognition.interimResults = true;
    voiceBaseTextRef.current = inputText.trimEnd();

    recognition.onresult = (event) => {
      let spokenText = '';
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        spokenText += ` ${result?.[0]?.transcript ?? ''}`;
      }

      const cleanedSpokenText = compactSpaces(spokenText);
      if (cleanedSpokenText) {
        setInputText(voiceBaseTextRef.current ? `${voiceBaseTextRef.current}\n${cleanedSpokenText}` : cleanedSpokenText);
      }
    };
    recognition.onerror = (event) => {
      setIsListening(false);
      setAssistantText(event.error === 'not-allowed' ? texts.assistant.voicePermissionDenied : texts.assistant.voiceError);
    };
    recognition.onend = () => {
      setIsListening(false);
      speechRecognitionRef.current = null;
    };

    try {
      recognition.start();
      setIsListening(true);
      setAssistantText(texts.assistant.voiceListening);
    } catch {
      setIsListening(false);
      setAssistantText(texts.assistant.voiceError);
    }
  };

  if (!loginSession) {
    return (
      <main className="app-shell login-shell">
        <div className="app-video-backdrop" aria-hidden="true">
          <video src={heroBackgroundVideo} autoPlay loop muted playsInline />
          <div className="app-video-overlay" />
        </div>
        <section className="login-panel" aria-labelledby="login-title">
          <p className="eyebrow">{texts.app.eyebrow}</p>
          <h1>{texts.app.title}</h1>
          <div>
            <h2 id="login-title">{texts.login.title}</h2>
            <p>{texts.login.subtitle}</p>
          </div>
          <form onSubmit={handleLoginSubmit}>
            <label>
              {texts.login.client}
              <input
                value={loginClient}
                onChange={(event) => {
                  setLoginClient(event.target.value);
                  setLoginError('');
                }}
                placeholder={texts.login.clientPlaceholder}
                autoComplete="username"
              />
            </label>
            <label>
              {texts.login.code}
              <input
                value={loginCode}
                onChange={(event) => {
                  setLoginCode(event.target.value);
                  setLoginError('');
                }}
                placeholder={texts.login.codePlaceholder}
                type="password"
                autoComplete="current-password"
              />
            </label>
            {loginError && <p className="login-error" role="alert">{loginError}</p>}
            <button type="submit">{texts.login.submit}</button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="app-video-backdrop" aria-hidden="true">
        <video src={heroBackgroundVideo} autoPlay loop muted playsInline />
        <div className="app-video-overlay" />
      </div>
      <header className="topbar">
        <div>
          <p className="eyebrow">{texts.app.eyebrow}</p>
          <h1>{texts.app.title}</h1>
        </div>
        <div className="topbar-actions">
          <span className="session-badge">
            {loginSession.clientName}
            {loginSession.role === 'admin' ? ` · ${texts.login.adminBadge}` : ` · ${texts.login.lockedTariff}`}
          </span>
          {loginSession.role === 'admin' && (
            <button type="button" className="secondary-button" onClick={() => setIsAdminPanelOpen((current) => !current)}>
              {isAdminPanelOpen ? texts.admin.close : texts.admin.open}
            </button>
          )}
          <button type="button" className="secondary-button" onClick={handleResetData}>
            {texts.app.resetDemo}
          </button>
          <button type="button" className="secondary-button" onClick={handleLogout}>
            {texts.app.logout}
          </button>
        </div>
      </header>

      {loginSession.role === 'admin' && isAdminPanelOpen && (
        <AdminAccessPanel
          users={accessUsers}
          catalogs={data.catalogs}
          onChange={handleAccessUsersChange}
          onSave={handleSaveAccessUsers}
          isSupabaseReady={isSupabaseReady}
          status={adminSaveStatus}
        />
      )}

      <section className={`assistant-start ${isThinking ? 'is-thinking' : ''}`}>
          <div className="assistant-hero">
            <h2 className="assistant-question">{texts.assistant.question}</h2>
            <p className="assistant-lead">{assistantText}</p>
            {isThinking && (
              <div className="thinking-indicator" role="status" aria-live="polite">
                <span className="thinking-dot" />
                <span className="thinking-dot" />
                <span className="thinking-dot" />
                <strong>{thinkingText}</strong>
              </div>
            )}
          </div>

          <section className="composer-panel">
            <div className="context-strip">
              <label>
                {texts.fields.catalog}
                <select value={selectedCatalogId} onChange={(event) => handleCatalogChange(event.target.value)} disabled={isThinking || availableCatalogs.length <= 1}>
                  {availableCatalogs.map((catalog) => (
                    <option key={catalog.id} value={catalog.id}>
                      {catalog.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {texts.fields.client}
                <input
                  value={clientName}
                  onChange={(event) => setClientName(event.target.value)}
                  placeholder={texts.assistant.clientPlaceholder}
                  disabled={isThinking || loginSession.role !== 'admin'}
                />
              </label>
            </div>
            <label>
              {texts.assistant.writeLabel}
              <textarea
                rows={5}
                value={inputText}
                onChange={(event) => setInputText(event.target.value)}
                onPaste={handleInstructionPaste}
                placeholder={texts.assistant.placeholder}
                disabled={isThinking}
              />
            </label>
            {attachedDocuments.length > 0 && (
              <div className="attached-documents" aria-label={texts.assistant.attachedDocuments}>
                <strong>{texts.assistant.attachedDocuments}</strong>
                <div className="attached-document-list">
                  {attachedDocuments.map((document) => (
                    <span key={document.id ?? document.fileName}>
                      {document.fileName}
                      <button
                        type="button"
                        className="attachment-remove-button"
                        onClick={() => handleRemoveAttachedDocument(document.id ?? document.fileName)}
                        disabled={isThinking}
                        aria-label={texts.assistant.removeAttachedDocument.replace('{name}', document.fileName)}
                        title={texts.assistant.removeAttachedDocument.replace('{name}', document.fileName)}
                      >
                        <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
                          <path d="M18 6 6 18" />
                          <path d="m6 6 12 12" />
                        </svg>
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="composer-actions">
              <input
                ref={assistantFileInputRef}
                className="visually-hidden"
                type="file"
                accept=".docx,.pdf,.txt,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,image/png,image/jpeg,image/webp"
                multiple
                onChange={handleAssistantDocumentUpload}
                aria-label={texts.assistant.uploadDocument}
              />
              <div className="composer-upload-action">
                <button type="button" className="secondary-button" onClick={() => assistantFileInputRef.current?.click()} disabled={isThinking}>
                  {thinkingState === 'documents' ? texts.assistant.uploadingDocument : texts.assistant.uploadDocument}
                </button>
              </div>
              <div className="composer-main-actions">
                <button type="button" onClick={handleProcessRequest} disabled={!hasRequestContent || isThinking}>
                  {thinkingState === 'analysis' ? texts.assistant.processing : texts.assistant.process}
                </button>
                <button type="button" onClick={handleTariffRequest} disabled={!hasRequestContent || isThinking}>
                  {thinkingState === 'pricing' ? texts.assistant.pricing : texts.assistant.tariff}
                </button>
                <button
                  type="button"
                  className={`secondary-button icon-button ${isListening ? 'is-listening' : ''}`}
                  onClick={handleVoiceInput}
                  aria-label={isListening ? texts.assistant.voiceStop : texts.assistant.voice}
                  title={isListening ? texts.assistant.voiceStop : texts.assistant.voice}
                  disabled={isThinking}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
                    <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" />
                    <path d="M19 11a7 7 0 0 1-14 0" />
                    <path d="M12 18v4" />
                    <path d="M8 22h8" />
                  </svg>
                  <span className="visually-hidden">{isListening ? texts.assistant.voiceStop : texts.assistant.voice}</span>
                </button>
              </div>
            </div>
          </section>

          {serviceAnalysis && (
            <AnalysisPanel
              analysis={serviceAnalysis}
              approved={isAnalysisApproved}
              pricingRequest={editablePricingRequest}
              catalogs={data.catalogs}
              vehicleOptionIndex={vehicleOptionIndex}
              onPricingRequestChange={handlePricingRequestChange}
              onApprove={handleApproveAnalysis}
              onTariff={handleTariffRequest}
              canTariff={hasRequestContent && isAnalysisApproved && !isThinking}
              thinkingState={thinkingState}
            />
          )}

          {quoteLines.length > 0 && serviceAnalysis?.pricingResult && (
            <QuotePanel lines={quoteLines} analysis={serviceAnalysis} documentMode={loginSession.role === 'admin' ? 'quote' : 'proposal'} />
          )}
      </section>

    </main>
  );
}

function AnalysisPanel({
  analysis,
  approved,
  pricingRequest,
  catalogs,
  vehicleOptionIndex,
  onPricingRequestChange,
  onApprove,
  onTariff,
  canTariff,
  thinkingState
}: {
  analysis: ServiceAnalysis;
  approved: boolean;
  pricingRequest: PricingRequest | null;
  catalogs: Catalog[];
  vehicleOptionIndex: VehicleOptionIndex;
  onPricingRequestChange: (request: PricingRequest | null) => void;
  onApprove: () => void;
  onTariff: () => void;
  canTariff: boolean;
  thinkingState: ThinkingState;
}) {
  const requestLines = analysis.request
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const detectedCriteria = buildDetectedPricingCriteria(pricingRequest);

  return (
    <section className="agent-panel assistant-review">
      <div className="agent-message">
        <h2>{texts.assistant.agentTitle}</h2>
        {analysis.summary && <p>{analysis.summary}</p>}
      </div>

      <div className="agent-card">
        <strong>{texts.assistant.agentUnderstood}</strong>
        <div className="agent-lines">
          {(requestLines.length ? requestLines : [analysis.request]).slice(0, 14).map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      </div>

      {detectedCriteria.length > 0 && (
        <div className="agent-card">
          <strong>{texts.assistant.detectedCriteria}</strong>
          <div className="agent-lines">
            {detectedCriteria.map((criterion) => (
              <span key={criterion}>{criterion}</span>
            ))}
          </div>
        </div>
      )}

      <PricingRequestEditor
        value={pricingRequest}
        missingData={analysis.missingData}
        catalogs={catalogs}
        vehicleOptionIndex={vehicleOptionIndex}
        onChange={onPricingRequestChange}
      />

      <div className="agent-footer">
        <span>
          {analysis.clientName} · {analysis.catalogName}
        </span>
        <div className="agent-footer-actions">
          <button type="button" onClick={onTariff} disabled={!canTariff}>
            {thinkingState === 'pricing' ? texts.assistant.pricing : texts.assistant.tariff}
          </button>
          <button type="button" className={approved ? 'secondary-button' : ''} onClick={onApprove} disabled={approved}>
            {approved ? texts.assistant.analysisApprovedShort : texts.assistant.approveAnalysis}
          </button>
        </div>
      </div>
    </section>
  );
}

function parseOptionalNumber(value: string) {
  if (!value.trim()) {
    return null;
  }

  const normalized = value.replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function hoursFromSchedule(value?: string | null) {
  return value ? scheduleHours[value] ?? null : null;
}

function AddressAutocomplete({
  label,
  value,
  placeholder,
  className,
  disabled = false,
  onChange
}: {
  label: string;
  value: string;
  placeholder: string;
  className?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState(value);
  const [predictions, setPredictions] = useState<PlacePrediction[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    const trimmed = query.trim();
    if (disabled || trimmed.length < 3) {
      setPredictions([]);
      setIsSearching(false);
      return;
    }

    let active = true;
    setIsSearching(true);
    const timeout = window.setTimeout(async () => {
      const results = await fetchPlacePredictions(trimmed);
      if (active) {
        setPredictions(results);
        setIsSearching(false);
      }
    }, 260);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [query, disabled]);

  const handleInputChange = (nextValue: string) => {
    if (disabled) {
      return;
    }
    setQuery(nextValue);
    setIsOpen(true);
    onChange(nextValue);
  };

  const handlePredictionSelect = async (prediction: PlacePrediction) => {
    setQuery(prediction.description);
    setIsOpen(false);
    setPredictions([]);
    const address = await fetchPlaceDetailsAddress(prediction.placeId, prediction.description);
    setQuery(address);
    onChange(address);
  };

  return (
    <label className={`address-autocomplete ${className ?? ''}`.trim()}>
      {label}
      <input
        value={query}
        onBlur={() => window.setTimeout(() => setIsOpen(false), 140)}
        onChange={(event) => handleInputChange(event.target.value)}
        onFocus={() => setIsOpen(true)}
        placeholder={placeholder}
        disabled={disabled}
      />
      {isOpen && (predictions.length > 0 || isSearching) && (
        <div className="address-suggestions">
          {isSearching && predictions.length === 0 && <span className="address-suggestion-status">Buscando en Google...</span>}
          {predictions.map((prediction) => (
            <button key={prediction.placeId} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => handlePredictionSelect(prediction)}>
              <strong>{prediction.mainText || prediction.description}</strong>
              {prediction.secondaryText && <small>{prediction.secondaryText}</small>}
            </button>
          ))}
        </div>
      )}
    </label>
  );
}

function AdminAccessPanel({
  users,
  catalogs,
  onChange,
  onSave,
  isSupabaseReady,
  status
}: {
  users: LoginSession[];
  catalogs: Catalog[];
  onChange: (users: LoginSession[]) => void;
  onSave: () => void;
  isSupabaseReady: boolean;
  status: string;
}) {
  const updateUser = (clientId: string, patch: Partial<LoginSession>) => {
    onChange(users.map((user) => (user.clientId === clientId ? { ...user, ...patch } : user)));
  };

  const addUser = () => {
    const nextIndex = users.length + 1;
    const firstCatalog = catalogs[0];
    onChange([
      ...users,
      {
        clientId: `cliente-${nextIndex}`,
        clientName: `Cliente ${nextIndex}`,
        code: `cliente${nextIndex}`,
        role: 'client',
        allowedCatalogIds: firstCatalog ? [firstCatalog.id] : [],
        isActive: true
      }
    ]);
  };

  return (
    <section className="admin-panel" aria-labelledby="admin-panel-title">
      <div className="section-heading">
        <div>
          <h2 id="admin-panel-title">{texts.admin.title}</h2>
          <p>{texts.admin.subtitle} {isSupabaseReady ? texts.admin.supabaseConnected : texts.admin.localNotice}</p>
        </div>
        <div className="admin-panel-actions">
          <button type="button" className="secondary-button" onClick={addUser}>
            {texts.admin.addUser}
          </button>
          <button type="button" onClick={onSave}>
            {texts.admin.save}
          </button>
        </div>
      </div>
      <div className="admin-table">
        <div className="admin-row admin-row-head">
          <span>{texts.admin.userName}</span>
          <span>{texts.admin.loginCode}</span>
          <span>{texts.admin.pin}</span>
          <span>{texts.admin.role}</span>
          <span>{texts.admin.assignedTariff}</span>
          <span>{texts.admin.status}</span>
        </div>
        {users.map((user) => {
          const selectedCatalogId = user.allowedCatalogIds.includes('*') ? '*' : user.allowedCatalogIds[0] ?? '';
          return (
            <div className="admin-row" key={user.clientId}>
              <label>
                <span className="visually-hidden">{texts.admin.userName}</span>
                <input value={user.clientName} onChange={(event) => updateUser(user.clientId, { clientName: event.target.value })} />
              </label>
              <label>
                <span className="visually-hidden">{texts.admin.loginCode}</span>
                <input value={user.clientId} onChange={(event) => updateUser(user.clientId, { clientId: normalizeText(event.target.value).replace(/[^a-z0-9]+/g, '-') || user.clientId })} />
              </label>
              <label>
                <span className="visually-hidden">{texts.admin.pin}</span>
                <input value={user.code} onChange={(event) => updateUser(user.clientId, { code: event.target.value })} />
              </label>
              <label>
                <span className="visually-hidden">{texts.admin.role}</span>
                <select
                  value={user.role}
                  onChange={(event) => {
                    const role = event.target.value === 'admin' ? 'admin' : 'client';
                    updateUser(user.clientId, {
                      role,
                      allowedCatalogIds: role === 'admin' ? ['*'] : user.allowedCatalogIds.includes('*') ? [catalogs[0]?.id].filter(Boolean) : user.allowedCatalogIds
                    });
                  }}
                >
                  <option value="client">{texts.admin.clientRole}</option>
                  <option value="admin">{texts.admin.adminRole}</option>
                </select>
              </label>
              <label>
                <span className="visually-hidden">{texts.admin.assignedTariff}</span>
                <select
                  value={selectedCatalogId}
                  onChange={(event) => {
                    const value = event.target.value;
                    updateUser(user.clientId, { allowedCatalogIds: value === '*' ? ['*'] : [value] });
                  }}
                >
                  <option value="*">{texts.admin.allTariffs}</option>
                  {catalogs.map((catalog) => (
                    <option key={catalog.id} value={catalog.id}>
                      {catalog.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="admin-active-toggle">
                <input type="checkbox" checked={user.isActive} onChange={(event) => updateUser(user.clientId, { isActive: event.target.checked })} />
                {user.isActive ? texts.admin.activeStatus : texts.admin.inactiveStatus}
              </label>
            </div>
          );
        })}
      </div>
      <p className="admin-notice">{status || (isSupabaseReady ? texts.admin.supabaseConnected : texts.admin.localNotice)}</p>
    </section>
  );
}

function PricingRequestEditor({
  value,
  missingData,
  catalogs,
  vehicleOptionIndex,
  onChange
}: {
  value: PricingRequest | null;
  missingData: string[];
  catalogs: Catalog[];
  vehicleOptionIndex: VehicleOptionIndex;
  onChange: (request: PricingRequest | null) => void;
}) {
  if (!value) {
    return (
      <div className="agent-card">
        <strong>{texts.assistant.editableParameters}</strong>
        <p>{texts.assistant.noEditableParameters}</p>
      </div>
    );
  }

  const update = (patch: Partial<PricingRequest>) => {
    onChange({ ...value, ...patch });
  };
  const updateFamily = (family: string | null) => {
    const allowedVehicles = getVehicleOptionsForCatalog(`${value.tariffId || ''} ${value.tariffName || ''}`, family, value.temperature);
    update({
      family,
      vehicleType: findAllowedVehicle(value.vehicleType, allowedVehicles)
    });
  };
  const updateTemperature = (temperature: string | null) => {
    const allowedVehicles = getVehicleOptionsForCatalog(`${value.tariffId || ''} ${value.tariffName || ''}`, value.family, temperature);
    update({
      temperature,
      vehicleType: findAllowedVehicle(value.vehicleType, allowedVehicles)
    });
  };
  const routeAddresses = (value.routeAddresses ?? []).map((address) => String(address || '').trim()).filter(Boolean);
  const addressesForDistance =
    routeAddresses.length >= 2
      ? routeAddresses
      : [value.originAddress, value.destinationAddress].map((address) => String(address || '').trim()).filter(Boolean);
  const canCalculateDistance = addressesForDistance.length >= 2;
  const updateRouteEndpoint = (endpoint: 'origin' | 'destination', nextAddress: string) => {
    const cleanedAddress = nextAddress.trim();
    const currentRoute =
      routeAddresses.length >= 2
        ? routeAddresses
        : [value.originAddress, value.destinationAddress].map((address) => String(address || '').trim()).filter(Boolean);

    if (!cleanedAddress) {
      update({
        [endpoint === 'origin' ? 'originAddress' : 'destinationAddress']: null,
        routeAddresses: null,
        distanceKm: null,
        additionalStops: null
      });
      return;
    }

    const nextRoute =
      endpoint === 'origin'
        ? currentRoute.length >= 2
          ? [cleanedAddress, ...currentRoute.slice(1)]
          : [cleanedAddress, String(value.destinationAddress || '').trim()]
        : currentRoute.length >= 2
          ? [...currentRoute.slice(0, -1), cleanedAddress]
          : [String(value.originAddress || '').trim(), cleanedAddress];
    const cleanedRoute = nextRoute.map((address) => address.trim()).filter(Boolean);

    update({
      [endpoint === 'origin' ? 'originAddress' : 'destinationAddress']: cleanedAddress,
      routeAddresses: cleanedRoute.length >= 2 ? cleanedRoute : null,
      distanceKm: null,
      additionalStops: cleanedRoute.length >= 2 ? Math.max(0, cleanedRoute.length - 2) : null
    });
  };
  const handleDistanceCalculation = async () => {
    if (isLastMileFamily) {
      await handleLastMileEstimatedDistance();
      return;
    }

    if (addressesForDistance.length < 2) {
      return;
    }

    const distance =
      addressesForDistance.length > 2
        ? await calculateRouteDistanceWithMaps(addressesForDistance, Boolean(value.routeOptimization) && !value.routeHasTimeConstraints)
        : await calculateDistanceWithMaps(addressesForDistance[0], addressesForDistance[1]);
    const calculatedRouteAddresses = distance.addresses ?? addressesForDistance;
    update({
      distanceKm: distance.distanceKm,
      originAddress: distance.origin,
      destinationAddress: distance.destination,
      routeAddresses: calculatedRouteAddresses,
      routeOptimization: Boolean(value.routeOptimization) && !value.routeHasTimeConstraints,
      additionalStops: Math.max(0, calculatedRouteAddresses.length - 2),
      notes: [
        value.notes,
        `${texts.assistant.mapsDistanceSource}: ${distance.distanceText}${distance.durationText ? ` · ${distance.durationText}` : ''}${'optimized' in distance && distance.optimized ? ` · ${texts.assistant.optimizedRoute}` : ''}`
      ]
        .filter(Boolean)
        .join('\n')
    });
  };
  const handleLastMileEstimatedDistance = async () => {
    const loadZone = String(value.loadZone || '').trim();
    const deliveryZone = String(value.deliveryZone || '').trim();
    if (!loadZone || !deliveryZone) {
      return;
    }

    const estimatedStops = Math.max(0, Number(value.estimatedStops ?? value.additionalStops ?? 0));
    const distance = await calculateLastMileDistanceEstimate(loadZone, deliveryZone, estimatedStops);

    update({
      distanceKm: distance.distanceKm,
      originAddress: loadZone,
      destinationAddress: deliveryZone,
      routeAddresses: [loadZone, deliveryZone, loadZone],
      additionalStops: estimatedStops,
      notes: [
        value.notes,
        distance.note
      ]
        .filter(Boolean)
        .join('\n')
    });
  };
  const vehicleOptions = getVehicleOptionsForCatalog(`${value.tariffId || ''} ${value.tariffName || ''}`, value.family, value.temperature);
  const isLastMileFamily = value.family === 'ultima_milla';
  const canCalculateLastMileEstimate = Boolean(value.loadZone && value.deliveryZone);
  const mozoRequirement = getMozoRequirement(value);
  const showMozoManual = mozoRequirement === 'manual_price';
  const showMozoHours = mozoRequirement === 'hours';
  const showMozoCount = mozoRequirement === 'fixed_count' || mozoRequirement === 'hours';
  const showVehicleSchedule = !isMeteorPricingRequest(value);

  return (
    <div className="agent-card parameter-editor">
      <strong>{texts.assistant.editableParameters}</strong>
      {missingData.length > 0 && (
        <div className="missing-summary">
          <span>{texts.assistant.missingData}</span>
          <div>
            {missingData.map((item) => (
              <small key={item}>{item}</small>
            ))}
          </div>
        </div>
      )}
      <div className="parameter-grid">
        {routeAddresses.length > 2 && (
          <div className="route-summary parameter-wide">
            <span>{texts.assistant.routeUsedForDistance}</span>
            <strong>{routeAddresses.length} {texts.assistant.stops.toLowerCase()}</strong>
          </div>
        )}
        <AddressAutocomplete
          className="parameter-wide"
          label={texts.assistant.parameterOrigin}
          value={value.originAddress ?? ''}
          onChange={(address) => updateRouteEndpoint('origin', address)}
          placeholder="Dirección de origen"
          disabled={isLastMileFamily}
        />
        <AddressAutocomplete
          className="parameter-wide"
          label={texts.assistant.parameterDestination}
          value={value.destinationAddress ?? ''}
          onChange={(address) => updateRouteEndpoint('destination', address)}
          placeholder="Dirección de destino"
          disabled={isLastMileFamily}
        />
        <label>
          {texts.assistant.parameterFamily}
          <select value={value.family ?? ''} onChange={(event) => updateFamily(event.target.value || null)}>
            <option value="">Pendiente</option>
            <option value="directos">Directos</option>
            <option value="ultima_milla">Última milla</option>
            <option value="distribucion">Distribución</option>
            <option value="mensajeria">Mensajería</option>
            <option value="almacenaje">Almacenaje</option>
          </select>
        </label>
        <label>
          {texts.assistant.parameterVehicle}
          <select value={value.vehicleType ?? ''} onChange={(event) => update({ vehicleType: event.target.value || null })}>
            <option value="">Pendiente</option>
            {vehicleOptions.map((vehicle) => (
              <option key={vehicle} value={vehicle}>
                {vehicle}
              </option>
            ))}
          </select>
        </label>
        <label>
          {texts.assistant.parameterDistance}
          <input type="number" min="0" step="0.1" value={value.distanceKm ?? ''} onChange={(event) => update({ distanceKm: parseOptionalNumber(event.target.value) })} />
        </label>
        <label>
          {texts.assistant.parameterWeight}
          <input type="number" min="0" step="0.1" value={value.weightKg ?? ''} onChange={(event) => update({ weightKg: parseOptionalNumber(event.target.value) })} />
        </label>
        <label>
          {texts.assistant.parameterTemperature}
          <select value={value.temperature ?? ''} onChange={(event) => updateTemperature(event.target.value || null)}>
            <option value="">Pendiente</option>
            <option value="seco">Seco</option>
            <option value="frio">Frío</option>
            <option value="refrigerado">Refrigerado</option>
            <option value="congelado">Congelado</option>
          </select>
        </label>
        <label>
          {texts.assistant.parameterAdditionalStops}
          <input type="number" min="0" step="1" value={value.additionalStops ?? ''} onChange={(event) => update({ additionalStops: parseOptionalNumber(event.target.value) })} />
        </label>
        <label>
          {texts.assistant.parameterWaitHours}
          <select value={value.waitHours ?? ''} onChange={(event) => update({ waitHours: parseOptionalNumber(event.target.value) })}>
            <option value="">Pendiente</option>
            {waitHourOptions.map((hours) => (
              <option key={hours} value={hours}>
                {hours} h
              </option>
            ))}
            {value.waitHours !== null && value.waitHours !== undefined && !waitHourOptions.includes(value.waitHours) && (
              <option value={value.waitHours}>{value.waitHours} h</option>
            )}
          </select>
        </label>
        {showMozoManual && (
          <label className="inline-field">
            <input
              type="checkbox"
              checked={Number(value.mozoCount ?? 0) > 0}
              onChange={(event) => update({ mozoCount: event.target.checked ? 1 : null, mozoHours: null, mozoSchedule: null, mozoManualPrice: event.target.checked ? value.mozoManualPrice ?? null : null })}
            />
            Mozo
          </label>
        )}
        {showMozoManual && Number(value.mozoCount ?? 0) > 0 && (
          <label>
            {texts.assistant.parameterMozoManualPrice}
            <input type="number" min="0" step="0.01" value={value.mozoManualPrice ?? ''} onChange={(event) => update({ mozoManualPrice: parseOptionalNumber(event.target.value) })} />
          </label>
        )}
        {showMozoHours && (
          <label>
            {texts.assistant.parameterMozoSchedule}
            <select
              value={value.mozoSchedule ?? ''}
              onChange={(event) => {
                const mozoSchedule = event.target.value || null;
                update({ mozoSchedule, mozoHours: hoursFromSchedule(mozoSchedule) ?? value.mozoHours ?? null });
              }}
            >
              <option value="">Pendiente</option>
              {scheduleOptions.map((schedule) => (
                <option key={schedule.value} value={schedule.value}>
                  {schedule.label}
                </option>
              ))}
            </select>
            <small>{texts.assistant.mozoScheduleHelp}</small>
          </label>
        )}
        {showMozoHours && (
          <label>
            {texts.assistant.parameterMozoHours}
            <input type="number" min="0" step="0.25" value={value.mozoHours ?? ''} onChange={(event) => update({ mozoHours: parseOptionalNumber(event.target.value) })} />
          </label>
        )}
        {showMozoCount && (
          <label>
            {texts.assistant.parameterMozoCount}
            <input type="number" min="1" step="1" value={value.mozoCount ?? ''} onChange={(event) => update({ mozoCount: parseOptionalNumber(event.target.value) })} />
          </label>
        )}
        {showVehicleSchedule && (
          <label>
            {texts.assistant.parameterVehicleSchedule}
            <select
              value={value.vehicleSchedule ?? value.schedule ?? ''}
              onChange={(event) => {
                const vehicleSchedule = event.target.value || null;
                update({ vehicleSchedule, schedule: vehicleSchedule });
              }}
            >
              <option value="">Pendiente</option>
              {scheduleOptions.map((schedule) => (
                <option key={schedule.value} value={schedule.value}>
                  {schedule.label}
                </option>
              ))}
            </select>
            <small>{texts.assistant.vehicleScheduleHelp}</small>
          </label>
        )}
      </div>
      {isLastMileFamily && (
        <div className="last-mile-estimator">
          <strong>{texts.assistant.lastMileEstimatorTitle}</strong>
          <p>{texts.assistant.lastMileEstimatorHelp}</p>
          <div className="parameter-grid">
            <AddressAutocomplete
              className="parameter-wide"
              label={texts.assistant.parameterLoadZone}
              value={value.loadZone ?? ''}
              onChange={(address) => update({ loadZone: address || null, distanceKm: null })}
              placeholder="Zona o dirección de carga"
            />
            <AddressAutocomplete
              className="parameter-wide"
              label={texts.assistant.parameterDeliveryZone}
              value={value.deliveryZone ?? ''}
              onChange={(address) => update({ deliveryZone: address || null, distanceKm: null })}
              placeholder="Zona de reparto"
            />
            <label>
              {texts.assistant.parameterEstimatedStops}
              <input
                type="number"
                min="0"
                step="1"
                value={value.estimatedStops ?? value.additionalStops ?? ''}
                onChange={(event) => {
                  const estimatedStops = parseOptionalNumber(event.target.value);
                  update({ estimatedStops, additionalStops: estimatedStops, distanceKm: null });
                }}
              />
            </label>
            <label>
              {texts.assistant.parameterServiceDays}
              <input
                type="number"
                min="1"
                step="1"
                value={value.serviceDays ?? ''}
                onChange={(event) => update({ serviceDays: parseOptionalNumber(event.target.value) })}
              />
            </label>
            <label>
              {texts.assistant.parameterStopAverage}
              <input value="0,3 km" disabled readOnly />
            </label>
          </div>
          <button type="button" className="secondary-button" onClick={handleLastMileEstimatedDistance} disabled={!canCalculateLastMileEstimate}>
            {texts.assistant.calculateLastMileDistance}
          </button>
        </div>
      )}
      <div className="parameter-toggles">
        <button type="button" className="secondary-button" onClick={handleDistanceCalculation} disabled={isLastMileFamily ? !canCalculateLastMileEstimate : !canCalculateDistance}>
          {texts.assistant.calculateDistance}
        </button>
        <label>
          <input type="checkbox" checked={Boolean(value.liftPlatform)} onChange={(event) => update({ liftPlatform: event.target.checked })} />
          {texts.assistant.parameterLiftPlatform}
        </label>
        <label>
          <input type="checkbox" checked={Boolean(value.roundTrip)} onChange={(event) => update({ roundTrip: event.target.checked })} />
          {texts.assistant.parameterRoundTrip}
        </label>
        <label>
          <input type="checkbox" checked={Boolean(value.batchedRoute)} onChange={(event) => update({ batchedRoute: event.target.checked })} />
          {texts.assistant.parameterBatchedRoute}
        </label>
        <label>
          <input
            type="checkbox"
            checked={Boolean(value.routeOptimization)}
            disabled={Boolean(value.routeHasTimeConstraints)}
            onChange={(event) => update({ routeOptimization: event.target.checked })}
          />
          {texts.assistant.parameterRouteOptimization}
        </label>
      </div>
    </div>
  );
}

function QuotePanel({
  lines,
  analysis,
  documentMode
}: {
  lines: QuoteLine[];
  analysis: ServiceAnalysis | null;
  documentMode: QuoteDocumentMode;
}) {
  const total = lines.reduce((sum, line) => sum + line.total, 0);
  const pricingResult = analysis?.pricingResult;
  const financialSummary = analysis?.pricingResult?.financialSummary;
  const workflowRules = pricingResult?.workflowRules;
  const pricingMeta = pricingResult?.meta ?? {};
  const displayedTariff = analysis?.pricingRequest?.tariffName || String(pricingMeta.tariff || '') || analysis?.catalogName || texts.assistant.noData;
  const displayedClient = analysis?.clientName || texts.system.defaultClient;
  const [isQuoteDraftOpen, setIsQuoteDraftOpen] = useState(false);
  const [quoteRecipient, setQuoteRecipient] = useState('');
  const [quoteSubject, setQuoteSubject] = useState('');
  const [quoteMessage, setQuoteMessage] = useState('');
  const [quoteStatus, setQuoteStatus] = useState('');
  const isProposalMode = documentMode === 'proposal';

  const openQuoteDraft = () => {
    setQuoteSubject((current) => current || buildQuoteSubject(analysis, displayedClient, displayedTariff, documentMode));
    setQuoteMessage(buildQuoteDraftText(lines, analysis, displayedClient, displayedTariff, documentMode));
    setQuoteStatus('');
    setIsQuoteDraftOpen(true);
  };

  const handleCopyQuote = async () => {
    try {
      await navigator.clipboard.writeText(`${quoteSubject}\n\n${quoteMessage}`);
      setQuoteStatus(isProposalMode ? texts.assistant.proposalCopied : texts.assistant.quoteCopied);
    } catch {
      setQuoteStatus(texts.assistant.quoteCopyError);
    }
  };

  const mailtoHref = `mailto:${encodeURIComponent(quoteRecipient.trim())}?subject=${encodeURIComponent(quoteSubject)}&body=${encodeURIComponent(quoteMessage)}`;

  return (
    <section className="review-panel assistant-review">
      <div className="section-heading">
        <div>
          <h2>{texts.assistant.quoteTitle}</h2>
        </div>
        <div className="quote-heading-actions">
          {lines.length > 0 && <strong>{currencyFormatter.format(total)}</strong>}
          {lines.length > 0 && (
            <button type="button" onClick={openQuoteDraft}>
              {isProposalMode ? texts.assistant.sendProposal : texts.assistant.sendQuote}
            </button>
          )}
        </div>
      </div>
      {lines.length === 0 ? (
        <p className="empty-state">{texts.assistant.quoteEmpty}</p>
      ) : (
        <>
          {analysis && (
            <div className="analysis-grid quote-meta">
              <div>
                <strong>{texts.assistant.selectedClient}</strong>
                <span>{displayedClient}</span>
              </div>
              <div>
                <strong>{texts.assistant.selectedTariff}</strong>
                <span>{displayedTariff}</span>
              </div>
              <div>
                <strong>{texts.assistant.tariffCriterion}</strong>
                <span>{workflowRules?.source || texts.system.defaultCatalogDescription}</span>
              </div>
              <div>
                <strong>{texts.assistant.pricingModel}</strong>
                <span>{describePricingModel(pricingResult?.pricingModel)}</span>
              </div>
            </div>
          )}
          {pricingResult && (
            <div className="quote-calculation-detail">
              <div className="calculation-heading">
                <strong>{texts.assistant.calculationBreakdown}</strong>
                <span>
                  {pricingResult.family} · {pricingMeta.vehicleType ? `${formatMetaValue(pricingMeta.vehicleType)} · ` : ''}
                  {pricingMeta.distanceKm ? `${formatMetaValue(pricingMeta.distanceKm)} km` : texts.assistant.noData}
                </span>
              </div>
              <div className="calculation-detail-grid">
                {pricingResult.breakdown.map((line) => (
                  <article key={line.code} className="calculation-line">
                    <div>
                      <strong>{line.label}</strong>
                      <span>{line.type === 'surcharge' ? 'Recargo' : line.type === 'discount' ? 'Descuento' : 'Base'}</span>
                    </div>
                    <p>{buildOperationFormula(line)}</p>
                    {line.meta && Object.keys(line.meta).length > 0 && (
                      <small>
                        {formatMetaEntries(line.meta)}
                      </small>
                    )}
                  </article>
                ))}
              </div>
              <div className="calculation-rules">
                <span>
                  {texts.assistant.distanceCriterion}: {describeDistanceCriterion(analysis)}
                </span>
                <span>
                  {texts.assistant.minimumCriterion}: {workflowRules?.minimumPriceEnforced ? 'mínimo aplicado' : 'sin mínimo forzado'}
                </span>
                {pricingResult.tariffVersion && <span>Versión tarifario: {pricingResult.tariffVersion}</span>}
              </div>
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{texts.fields.service}</th>
                  <th>{texts.assistant.quantity}</th>
                  <th>{texts.fields.price}</th>
                  <th>{texts.assistant.lineTotal}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.itemId}>
                    <td>{line.itemName}</td>
                    <td>
                      {line.quantity} {line.unit}
                    </td>
                    <td>{currencyFormatter.format(line.unitPrice)}</td>
                    <td>{currencyFormatter.format(line.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {financialSummary && (
            <div className="quote-financial-summary">
              <div>
                <span>Base imponible</span>
                <strong>{currencyFormatter.format(financialSummary.base_imponible)}</strong>
              </div>
              <div>
                <span>IVA {financialSummary.iva_porcentaje}%</span>
                <strong>{currencyFormatter.format(financialSummary.iva_importe)}</strong>
              </div>
              <div>
                <span>Total con IVA</span>
                <strong>{currencyFormatter.format(financialSummary.total_con_iva)}</strong>
              </div>
            </div>
          )}
          {isQuoteDraftOpen && (
            <div className="modal-backdrop" role="presentation">
              <section className="quote-draft-modal" role="dialog" aria-modal="true" aria-labelledby="quote-draft-title">
                <div className="section-heading">
                  <div>
                    <h2 id="quote-draft-title">{isProposalMode ? texts.assistant.proposalDraftTitle : texts.assistant.quoteDraftTitle}</h2>
                  </div>
                  <button type="button" className="secondary-button" onClick={() => setIsQuoteDraftOpen(false)}>
                    {texts.assistant.quoteClose}
                  </button>
                </div>
                <div className="quote-draft-grid">
                  <label>
                    {texts.assistant.quoteRecipient}
                    <input
                      value={quoteRecipient}
                      onChange={(event) => setQuoteRecipient(event.target.value)}
                      placeholder={texts.assistant.quoteRecipientPlaceholder}
                      type="email"
                    />
                  </label>
                  <label>
                    {texts.assistant.quoteSubject}
                    <input value={quoteSubject} onChange={(event) => setQuoteSubject(event.target.value)} />
                  </label>
                  <label className="quote-draft-message">
                    {isProposalMode ? texts.assistant.proposalMessage : texts.assistant.quoteMessage}
                    <textarea rows={14} value={quoteMessage} onChange={(event) => setQuoteMessage(event.target.value)} />
                  </label>
                </div>
                {quoteStatus && <p className="quote-draft-status">{quoteStatus}</p>}
                <div className="quote-draft-actions">
                  <button type="button" className="secondary-button" onClick={handleCopyQuote}>
                    {texts.assistant.quoteCopy}
                  </button>
                  <a className="button-link" href={mailtoHref}>
                    {texts.assistant.quoteOpenEmail}
                  </a>
                </div>
              </section>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function InfoList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div className="info-list">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export default App;



