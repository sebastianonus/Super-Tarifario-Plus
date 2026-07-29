import 'dotenv/config';
import { createRequire } from 'node:module';
import { createSign } from 'node:crypto';
import express from 'express';
import OpenAI from 'openai';
import { isSupabaseConfigured, requireSupabaseAdmin } from './supabase-client.mjs';

const require = createRequire(import.meta.url);
const { calculatePrice, PricingError, getTariffCatalogSummary } = require('./pricing/price-engine.cjs');

const app = express();
const port = Number(process.env.API_PORT ?? 8787);
const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const ivaPercentage = Number(process.env.IVA_PERCENTAGE ?? 21);
const googleMapsApiKey = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
const googleDistanceMatrixUrl = 'https://maps.googleapis.com/maps/api/distancematrix/json';
const googleDirectionsUrl = 'https://maps.googleapis.com/maps/api/directions/json';
const googlePlacesAutocompleteUrl = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';
const googlePlaceDetailsUrl = 'https://maps.googleapis.com/maps/api/place/details/json';
const googleGeocodingUrl = 'https://maps.googleapis.com/maps/api/geocode/json';
const googleRouteOptimizationUrl = 'https://routeoptimization.googleapis.com/v1';
const googleCloudProjectId = String(process.env.GOOGLE_CLOUD_PROJECT_ID || '').trim();
const googleRouteOptimizationAccessToken = String(process.env.GOOGLE_ROUTE_OPTIMIZATION_ACCESS_TOKEN || '').trim();
const googleRouteOptimizationServiceAccountJson = String(process.env.GOOGLE_ROUTE_OPTIMIZATION_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '').trim();

app.use(express.json({ limit: '25mb' }));

const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const hasUsableApiKey = Boolean(process.env.OPENAI_API_KEY && /^sk-[A-Za-z0-9_-]+$/.test(process.env.OPENAI_API_KEY));
const requireRealAi = process.env.REQUIRE_REAL_AI !== 'false';
const googleMapsEnabled = googleMapsApiKey.length > 0;
const googleRouteOptimizationEnabled = Boolean(googleCloudProjectId && (googleRouteOptimizationAccessToken || googleRouteOptimizationServiceAccountJson));
let googleRouteOptimizationTokenCache = null;

function mapAccessUser(row, allowedCatalogIds = []) {
  return {
    clientId: row.login_code,
    clientName: row.name,
    code: row.pin,
    role: row.role,
    allowedCatalogIds: row.can_view_all_tariffs ? ['*'] : allowedCatalogIds,
    isActive: Boolean(row.is_active)
  };
}

async function getAllowedCatalogIdsForClient(supabase, user) {
  if (user.can_view_all_tariffs) {
    return ['*'];
  }

  if (!user.client_id) {
    return [];
  }

  const { data, error } = await supabase
    .from('client_tariffs')
    .select('tariffs(code)')
    .eq('client_id', user.client_id);

  if (error) {
    throw error;
  }

  return (data ?? [])
    .map((entry) => entry.tariffs?.code)
    .filter(Boolean);
}

async function syncAccessUserToSupabase(supabase, user) {
  const loginCode = String(user.clientId || '').trim().toLowerCase();
  const name = String(user.clientName || '').trim();
  const pin = String(user.code || '').trim();
  const role = user.role === 'admin' ? 'admin' : 'client';
  const canViewAllTariffs = role === 'admin' || (Array.isArray(user.allowedCatalogIds) && user.allowedCatalogIds.includes('*'));

  if (!loginCode || !name || !pin) {
    throw new Error('Cada usuario necesita nombre, código cliente y PIN.');
  }

  const { data: clientRow, error: clientError } = await supabase
    .from('clients')
    .upsert({ code: loginCode, name, is_active: Boolean(user.isActive) }, { onConflict: 'code' })
    .select('id')
    .single();

  if (clientError) {
    throw clientError;
  }

  const { error: userError } = await supabase
    .from('access_users')
    .upsert(
      {
        login_code: loginCode,
        name,
        pin,
        role,
        client_id: clientRow.id,
        can_view_all_tariffs: canViewAllTariffs,
        is_active: Boolean(user.isActive)
      },
      { onConflict: 'login_code' }
    );

  if (userError) {
    throw userError;
  }

  if (!canViewAllTariffs) {
    await supabase.from('client_tariffs').delete().eq('client_id', clientRow.id);
    const allowedCatalogIds = Array.isArray(user.allowedCatalogIds) ? user.allowedCatalogIds.filter(Boolean) : [];
    if (allowedCatalogIds.length > 0) {
      const { data: tariffs, error: tariffError } = await supabase
        .from('tariffs')
        .select('id, code')
        .in('code', allowedCatalogIds);

      if (tariffError) {
        throw tariffError;
      }

      const rows = (tariffs ?? []).map((tariff, index) => ({
        client_id: clientRow.id,
        tariff_id: tariff.id,
        is_default: index === 0
      }));

      if (rows.length > 0) {
        const { error: relationError } = await supabase
          .from('client_tariffs')
          .upsert(rows, { onConflict: 'client_id,tariff_id' });

        if (relationError) {
          throw relationError;
        }
      }
    }
  }
}

const tariffAnalysisPrompt =
  'Extrae parametros tarifables de una peticion logistica y prepara calculo. Prioridad absoluta: direcciones de recogida y entrega, numero de bultos, peso, dimensiones, volumen, tipo de mercancia, numero de paradas, fecha y ventanas horarias. Razona la frase en contexto: si el usuario dice "urgente para mañana", "para mañana", "hoy" o equivalente, no crees modality "urgente"; marca operationalSurcharges.requestLessThan24h=true porque implica solicitud con 24h o menos. Si dice menos de 48h o pasado mañana, marca requestLessThan48h=true. No des una explicacion operativa larga. No inventes pesos ni medidas. Si faltan peso o dimensiones, declaralos como missingData. Si el tarifario es ONUS/Onus Express y los datos bastan, rellena pricingRequest compatible con el motor: family mensajeria|ultima_milla|distribucion|directos|almacenaje; usa distanceKm si aparece; para directos usa vehicleType, temperature, additionalStops, waitHours, roundTrip, liftPlatform y usa modality solo para recargos reales como express, nocturno/festivo o sabado, nunca para urgente por antelacion, seco/frio/refrigerado/congelado; para recargos por antelacion usa operationalSurcharges.requestLessThan24h o requestLessThan48h; para distribucion usa distributionType, destination, weightKg; para ultima_milla usa vehicleType, schedule, temperature, distanceKm, driverCount, serviceDays. Si no hay datos suficientes, pricingRequest debe ser null. Usa el tarifario para proponer filas candidatas.';

const logisticsSystemPrompt =
  'Eres un analista experto en operaciones logisticas y tarificacion de servicios de transporte. Tu prioridad es la precision. No inventes datos para completar campos. Cuando existan contradicciones, usa este orden: 1 correcciones del usuario, 2 reglas del sistema, 3 tarifario vigente, 4 albaranes/documentos oficiales, 5 texto descriptivo, 6 estimaciones razonadas. Nunca ocultes una contradiccion: registrala. Extrae operativa, ruta, paradas, horarios, contactos, mercancia, vehiculo y recursos. Mantén direccion_original y direccion_normalizada. No inventes calles, CP, municipios, pesos, dimensiones ni kilometros. Diferencia bultos fisicos, movimientos de bultos y carga maxima simultanea. El vehiculo se recomienda por carga maxima simultanea, no por suma acumulada de movimientos. Si falta peso o dimensiones, usa null en confirmados; solo estima si la politica permite estimaciones, siempre con rango y marcando pendiente de confirmacion. No calcules kilometros por intuicion: si no vienen de API o usuario, distance_status debe ser pendiente_de_calcular. La IA propone reglas y estructura; el codigo calcula importes. Nunca generes importes monetarios finales ni precios unitarios por tu cuenta: si un concepto no ha sido calculado por codigo, precio_unitario, importe, base_imponible, iva_importe y total_con_iva deben ser 0 y calculado_por_codigo false. No cierres una tarifa definitiva si faltan datos criticos.';

const routeAwareTariffAnalysisPrompt = [
  tariffAnalysisPrompt,
  'Si el usuario aporta direcciones, poblaciones o establecimientos, rellena originAddress, destinationAddress y routeAddresses en pricingRequest. routeAddresses debe conservar todas las paradas utiles en orden operativo. Si solo hay una entrega para distribucion, usa destinationAddress como referencia de entrega. No dejes las direcciones solo en summary o serviceDescription.',
  'Si cualquier parada tiene hora estricta, cita, franja horaria, horario de recogida/entrega, "antes de", "despues de", "a partir de" o una hora concreta asociada a recogida/entrega, marca routeHasTimeConstraints=true y rellena routeStops con address, label, timeWindowStart, timeWindowEnd y priority. Usa routeOptimization=true solo si el usuario pide optimizar o mejorar la ruta; entonces la optimizacion debera respetar esos horarios.'
].join(' ');

const logisticsRouteExtractionPrompt = [
  'Extrae una ruta ordenada con TODAS las paradas que aparezcan en albaranes, emails, capturas e instrucciones.',
  'Cada direccion encontrada debe convertirse en un item de ruta, no en un resumen generico.',
  'En albaranes, trata campos como ADRECA DE RECOLLIDA, ADRECA LLIURAMENT, DIRECCION DE RECOGIDA, DIRECCION DE ENTREGA, CONTACTE, TELEFONO, HORARI y UNITATS DESCRIPCIO como datos criticos.',
  'Si una parada incluye hora exacta, cita, franja, "antes de", "despues de", "a partir de", apertura/cierre o cualquier restriccion temporal, rellena horario_desde y/o horario_hasta en esa parada. Esos horarios condicionan el orden de la ruta.',
  'En instrucciones en catalan, "Recollir a X per Y" significa recogida en X y entrega en Y; "lliurar a Y" significa entrega en Y. Cada X e Y debe aparecer como parada separada si es una localidad o direccion.',
  'La expresion "3500 amb plataforma" o "3500 con plataforma" normalmente significa vehiculo de 3500 kg con plataforma, no 3500 bultos ni 3500 kg de mercancia. En ese caso informa vehiculo_recomendado y recurso plataforma, y deja peso_confirmado_kg como null salvo que el documento diga explicitamente peso de la mercancia.',
  'Si hay varios albaranes, consolida paradas sin perder ninguna direccion.',
  'Manten direccion_original exactamente como aparece y direccion_normalizada limpia para navegacion.',
  'No calcules kilometros: si no vienen de API o usuario, distance_status debe ser pendiente_de_calcular para que el codigo consulte Google Maps despues.'
  + ' Si las correcciones_usuario indican una distancia en km validada por Onus o por el usuario, usala como distancia_km confirmada y fuente_distancia usuario_onus.'
].join(' ');

const analysisSchema = {
  name: 'service_tariff_analysis',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      requestData: {
        type: 'object',
        additionalProperties: false,
        properties: {
          client: { type: 'string' },
          catalog: { type: 'string' },
          serviceDescription: { type: 'string' },
          urgency: { type: 'boolean' },
          assumptions: { type: 'array', items: { type: 'string' } },
          missingData: { type: 'array', items: { type: 'string' } }
        },
        required: ['client', 'catalog', 'serviceDescription', 'urgency', 'assumptions', 'missingData']
      },
      candidateServices: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            itemId: { type: 'string' },
            itemName: { type: 'string' },
            sheetName: { type: 'string' },
            reason: { type: 'string' },
            quantity: { type: 'number' },
            confidence: { type: 'number' }
          },
          required: ['itemId', 'itemName', 'sheetName', 'reason', 'quantity', 'confidence']
        }
      },
      pricingRequest: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: {
          family: { type: ['string', 'null'] },
          serviceLevel: { type: ['string', 'null'] },
          distributionType: { type: ['string', 'null'] },
          destination: { type: ['string', 'null'] },
          zone: { type: ['string', 'null'] },
          vehicleType: { type: ['string', 'null'] },
          schedule: { type: ['string', 'null'] },
          temperature: { type: ['string', 'null'] },
          distanceKm: { type: ['number', 'null'] },
          weightKg: { type: ['number', 'null'] },
          driverCount: { type: ['number', 'null'] },
          serviceDays: { type: ['number', 'null'] },
          extraHours: { type: ['number', 'null'] },
          nightHours: { type: ['number', 'null'] },
          additionalStops: { type: ['number', 'null'] },
          waitHours: { type: ['number', 'null'] },
          modality: {
            type: ['array', 'null'],
            items: { type: 'string' }
          },
          roundTrip: { type: ['boolean', 'null'] },
          closedTimeWindow: { type: ['boolean', 'null'] },
          liftPlatform: { type: ['boolean', 'null'] },
          secondAttempt: { type: ['boolean', 'null'] },
          returnRejected: { type: ['boolean', 'null'] },
          ticketCosts: { type: ['number', 'null'] },
          batchedRoute: { type: ['boolean', 'null'] },
          section: { type: ['string', 'null'] },
          concept: { type: ['string', 'null'] },
          quantity: { type: ['number', 'null'] },
          originAddress: { type: ['string', 'null'] },
          destinationAddress: { type: ['string', 'null'] },
          routeAddresses: {
            type: ['array', 'null'],
            items: { type: 'string' }
          },
          routeStops: {
            type: ['array', 'null'],
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                address: { type: 'string' },
                label: { type: ['string', 'null'] },
                timeWindowStart: { type: ['string', 'null'] },
                timeWindowEnd: { type: ['string', 'null'] },
                priority: { type: ['number', 'null'] }
              },
              required: ['address', 'label', 'timeWindowStart', 'timeWindowEnd', 'priority']
            }
          },
          routeHasTimeConstraints: { type: ['boolean', 'null'] },
          routeOptimization: { type: ['boolean', 'null'] },
          loadZone: { type: ['string', 'null'] },
          deliveryZone: { type: ['string', 'null'] },
          estimatedStops: { type: ['number', 'null'] },
          operationalSurcharges: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: {
              emptyDeparture: { type: ['boolean', 'null'] },
              requestLessThan48h: { type: ['boolean', 'null'] },
              requestLessThan24h: { type: ['boolean', 'null'] },
              sporadicRoute: { type: ['boolean', 'null'] },
              changePointConditions: { type: ['boolean', 'null'] },
              secondAttemptPenalty: { type: ['boolean', 'null'] },
              waitBlocks30m: { type: ['number', 'null'] },
              cancellationHoursBefore: { type: ['number', 'null'] }
            },
            required: [
              'emptyDeparture',
              'requestLessThan48h',
              'requestLessThan24h',
              'sporadicRoute',
              'changePointConditions',
              'secondAttemptPenalty',
              'waitBlocks30m',
              'cancellationHoursBefore'
            ]
          },
          clientPrice: { type: ['number', 'null'] }
        },
        required: [
          'family',
          'serviceLevel',
          'distributionType',
          'destination',
          'zone',
          'vehicleType',
          'schedule',
          'temperature',
          'distanceKm',
          'weightKg',
          'driverCount',
          'serviceDays',
          'extraHours',
          'nightHours',
          'additionalStops',
          'waitHours',
          'modality',
          'roundTrip',
          'closedTimeWindow',
          'liftPlatform',
          'secondAttempt',
          'returnRejected',
          'ticketCosts',
          'batchedRoute',
          'section',
          'concept',
          'quantity',
          'originAddress',
          'destinationAddress',
          'routeAddresses',
          'routeStops',
          'routeHasTimeConstraints',
          'routeOptimization',
          'loadZone',
          'deliveryZone',
          'estimatedStops',
          'operationalSurcharges',
          'clientPrice'
        ]
      }
    },
    required: ['summary', 'requestData', 'candidateServices', 'pricingRequest']
  },
  strict: true
};

const documentSchema = {
  name: 'tarificacion_logistica',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      estado: { type: 'string', enum: ['definitivo', 'provisional', 'pendiente', 'requiere_revision'] },
      servicio: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fecha: { type: ['string', 'null'] },
          tipo: { type: ['string', 'null'] },
          distancia_km: { type: ['number', 'null'] },
          distance_status: { type: 'string', enum: ['confirmada', 'pendiente_de_calcular'] },
          fuente_distancia: { type: ['string', 'null'] },
          duracion_horas: { type: ['number', 'null'] },
          resumen: { type: 'string' }
        },
        required: ['fecha', 'tipo', 'distancia_km', 'distance_status', 'fuente_distancia', 'duracion_horas', 'resumen']
      },
      ruta: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            orden: { type: 'number' },
            tipo: { type: 'string', enum: ['recogida', 'entrega', 'recogida_entrega'] },
            direccion_original: { type: 'string' },
            direccion_normalizada: { type: 'string' },
            horario_desde: { type: ['string', 'null'] },
            horario_hasta: { type: ['string', 'null'] },
            contacto: { type: ['string', 'null'] },
            telefono: { type: ['string', 'null'] },
            mercancia_recogida: { type: 'array', items: { type: 'string' } },
            mercancia_entregada: { type: 'array', items: { type: 'string' } }
          },
          required: [
            'orden',
            'tipo',
            'direccion_original',
            'direccion_normalizada',
            'horario_desde',
            'horario_hasta',
            'contacto',
            'telefono',
            'mercancia_recogida',
            'mercancia_entregada'
          ]
        }
      },
      mercancias: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            descripcion: { type: 'string' },
            cantidad: { type: ['number', 'null'] },
            peso_confirmado_kg: { type: ['number', 'null'] },
            peso_estimado_minimo_kg: { type: ['number', 'null'] },
            peso_estimado_maximo_kg: { type: ['number', 'null'] },
            dimensiones_confirmadas: { type: ['string', 'null'] },
            dimensiones_estimadas: { type: ['string', 'null'] },
            origen: { type: ['string', 'null'] },
            destino: { type: ['string', 'null'] },
            confianza: { type: 'number' },
            fuente: { type: 'string' }
          },
          required: [
            'descripcion',
            'cantidad',
            'peso_confirmado_kg',
            'peso_estimado_minimo_kg',
            'peso_estimado_maximo_kg',
            'dimensiones_confirmadas',
            'dimensiones_estimadas',
            'origen',
            'destino',
            'confianza',
            'fuente'
          ]
        }
      },
      carga: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bultos_fisicos_minimos: { type: ['number', 'null'] },
          bultos_fisicos_maximos: { type: ['number', 'null'] },
          movimientos_de_bultos: { type: ['number', 'null'] },
          carga_maxima_simultanea_bultos: { type: ['number', 'null'] },
          peso_confirmado_kg: { type: ['number', 'null'] },
          peso_estimado_minimo_kg: { type: ['number', 'null'] },
          peso_estimado_maximo_kg: { type: ['number', 'null'] },
          dimensiones_confirmadas: { type: ['string', 'null'] },
          vehiculo_recomendado: { type: ['string', 'null'] },
          recursos_necesarios: { type: 'array', items: { type: 'string' } }
        },
        required: [
          'bultos_fisicos_minimos',
          'bultos_fisicos_maximos',
          'movimientos_de_bultos',
          'carga_maxima_simultanea_bultos',
          'peso_confirmado_kg',
          'peso_estimado_minimo_kg',
          'peso_estimado_maximo_kg',
          'dimensiones_confirmadas',
          'vehiculo_recomendado',
          'recursos_necesarios'
        ]
      },
      tarificacion: {
        type: 'object',
        additionalProperties: false,
        properties: {
          conceptos: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                concepto: { type: 'string' },
                metodo: { type: 'string' },
                cantidad: { type: 'number' },
                unidad: { type: 'string' },
                precio_unitario: { type: 'number' },
                formula: { type: 'string' },
                importe: { type: 'number' },
                calculado_por_codigo: { type: 'boolean' }
              },
              required: ['concepto', 'metodo', 'cantidad', 'unidad', 'precio_unitario', 'formula', 'importe', 'calculado_por_codigo']
            }
          },
          base_imponible: { type: 'number' },
          iva_porcentaje: { type: 'number' },
          iva_importe: { type: 'number' },
          total_con_iva: { type: 'number' }
        },
        required: ['conceptos', 'base_imponible', 'iva_porcentaje', 'iva_importe', 'total_con_iva']
      },
      datos_confirmados: { type: 'array', items: { type: 'string' } },
      datos_estimados: { type: 'array', items: { type: 'string' } },
      datos_pendientes: { type: 'array', items: { type: 'string' } },
      contradicciones: { type: 'array', items: { type: 'string' } },
      advertencias_operativas: { type: 'array', items: { type: 'string' } },
      texto_limpio: { type: 'string' }
    },
    required: [
      'estado',
      'servicio',
      'ruta',
      'mercancias',
      'carga',
      'tarificacion',
      'datos_confirmados',
      'datos_estimados',
      'datos_pendientes',
      'contradicciones',
      'advertencias_operativas',
      'texto_limpio'
    ]
  },
  strict: true
};

const stopWords = new Set([
  'para',
  'con',
  'del',
  'las',
  'los',
  'una',
  'uno',
  'por',
  'que',
  'este',
  'esta',
  'desde',
  'hasta',
  'cliente',
  'servicio',
  'solicita',
  'necesita',
  'entrega',
  'envio',
  'envíos',
  'documento',
  'albaran',
  'albarán'
]);

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function tokenize(value) {
  return normalize(value)
    .split(/[^a-z0-9]+/i)
    .filter((word) => word.length > 2 && !stopWords.has(word));
}

function itemText(item) {
  return [
    item?.sheetName,
    item?.name,
    item?.originalDescription,
    ...(item?.originalValues ?? []),
    item?.code,
    item?.unit,
    item?.notes,
    ...Object.values(item?.criteria ?? {})
  ].join(' ');
}

function filterCatalogForRequest(requestText, catalog, limit = 90) {
  const items = catalog?.items ?? [];
  const queryTokens = tokenize(requestText);
  const query = normalize(requestText);

  if (items.length <= limit) {
    return { ...catalog, items };
  }

  const scored = items
    .map((item) => {
      const text = normalize(itemText(item));
      const tokens = new Set(tokenize(text));
      const overlap = queryTokens.reduce((score, token) => score + (tokens.has(token) || text.includes(token) ? 1 : 0), 0);
      const sheetBonus = item.sheetName && query.includes(normalize(item.sheetName)) ? 8 : 0;
      const coldBonus = /\bfrio|frigor|refriger|congel/i.test(requestText) && /frio|frigor|refriger|congel/i.test(itemText(item)) ? 6 : 0;
      const storageBonus = /\balmacen|stock|palet|picking/i.test(requestText) && /almacen|stock|palet|picking/i.test(itemText(item)) ? 6 : 0;
      const directBonus = /\bdirecto|dedicado|exclusiv/i.test(requestText) && /directo|dedicado|exclusiv/i.test(itemText(item)) ? 6 : 0;
      const lastMileBonus = /\bultima milla|montaje|instal/i.test(normalize(requestText)) && /ultima milla|montaje|instal/i.test(normalize(itemText(item))) ? 6 : 0;
      return { item, score: overlap + sheetBonus + coldBonus + storageBonus + directBonus + lastMileBonus };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  const filteredItems = scored.length > 0 ? scored.slice(0, limit).map(({ item }) => item) : items.slice(0, limit);
  return { ...catalog, items: filteredItems };
}

function compactCatalog(catalog) {
  return {
    id: catalog?.id,
    name: catalog?.name,
    description: catalog?.description,
    items: (catalog?.items ?? []).map((item) => ({
      id: item.id,
      sheetName: item.sheetName || '',
      originalDescription: item.originalDescription || '',
      originalValues: item.originalValues || [],
      code: item.code || '',
      name: item.name || '',
      unit: item.unit || '',
      unitPrice: Number(item.unitPrice) || 0,
      minimum: Number(item.minimum) || 1,
      notes: item.notes || '',
      criteria: item.criteria || {}
    }))
  };
}

function serviceItemName(item) {
  return item?.name || item?.originalDescription || (item?.originalValues ?? []).join(' | ') || item?.sheetName || '';
}

function compactSpaces(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function extractBetween(text, start, endLabels) {
  const normalizedText = compactSpaces(text);
  const upperText = normalizedText.toUpperCase();
  const startIndex = upperText.indexOf(start.toUpperCase());

  if (startIndex < 0) {
    return '';
  }

  const valueStart = startIndex + start.length;
  const nextEnd = endLabels
    .map((label) => upperText.indexOf(label.toUpperCase(), valueStart))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  return normalizedText.slice(valueStart, nextEnd ?? undefined).replace(/^[:\s]+/, '').trim();
}

function matchFirst(text, pattern) {
  const match = compactSpaces(text).match(pattern);
  return match ? match.slice(1).filter(Boolean).join(' ') : '';
}

function extractPackageCount(text) {
  const matches = [...String(text ?? '').matchAll(/\b(\d+)\s*(?:bultos?|armarios?|neveras?|prestagerias?|estanterias?|unidades?)?\b/gi)];
  const total = matches.reduce((sum, match) => sum + Number(match[1] || 0), 0);
  return Number.isFinite(total) ? total : 0;
}

function buildLocalServiceAnalysis(requestText, catalog, clientName) {
  const candidateCatalog = filterCatalogForRequest(requestText, catalog, 12);
  const candidates = (candidateCatalog.items ?? [])
    .filter((item) => serviceItemName(item))
    .slice(0, 8)
    .map((item) => ({
      itemId: item.id,
      itemName: serviceItemName(item),
      sheetName: item.sheetName || '',
      reason: 'Coincidencia local por palabras clave y hoja del tarifario.',
      quantity: 1,
      confidence: 0.45
    }));

  return {
    summary: 'Analisis local aplicado porque la IA no ha respondido. Revisa la propuesta antes de tarifar.',
    requestData: {
      client: clientName || '',
      catalog: catalog?.name || '',
      serviceDescription: requestText,
      urgency: /urgente|express|prioritario/i.test(requestText),
      assumptions: ['La seleccion se ha filtrado por coincidencias de texto contra el tarifario.'],
      missingData: candidates.length ? [] : ['No se han encontrado coincidencias suficientes en el tarifario.']
    },
    candidateServices: candidates
  };
}

function buildLocalDocumentAnalysis(documents, catalog, clientName) {
  const hasImages = documents.some((document) => document.imageData);
  const documentText = documents.map((document) => `${document.fileName}\n${document.text || ''}`).join('\n\n');
  const candidateCatalog = catalog ? filterCatalogForRequest(documentText, catalog, 12) : { items: [] };
  const hints = (candidateCatalog.items ?? [])
    .filter((item) => serviceItemName(item))
    .slice(0, 8)
    .map((item) => ({
      itemId: item.id,
      itemName: serviceItemName(item),
      sheetName: item.sheetName || '',
      reason: 'Coincidencia local por contenido del documento.'
    }));

  const extractedLines = documentText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 18);
  const pickupAddresses = documents
    .map((document) => extractBetween(document.text || '', 'ADREÇA DE RECOLLIDA:', ['HORARI DE RECOLLIDA:', 'CONTACTE:', 'ADREÇA LLIURAMENT:']))
    .filter(Boolean);
  const deliveryAddresses = documents
    .map((document) => extractBetween(document.text || '', 'ADREÇA LLIURAMENT:', ['UNITATS DESCRIPCIO / SKU', 'NOTES :']))
    .filter(Boolean);
  const goods = documents
    .map((document) => extractBetween(document.text || '', 'UNITATS DESCRIPCIO / SKU', ['NOTES :']))
    .filter(Boolean);

  return {
    serviceDescription: extractedLines.join('\n'),
    tariffParameters: {
      pickupAddresses,
      deliveryAddresses,
      stops: pickupAddresses.length + deliveryAddresses.length,
      packages: goods,
      totalPackages: extractPackageCount(goods.join(' ')),
      weight: matchFirst(documentText, /(\d+(?:[,.]\d+)?)\s*(kg|kilos?)/i),
      dimensions: [...documentText.matchAll(/(\d+(?:[,.]\d+)?\s*x\s*\d+(?:[,.]\d+)?(?:\s*x\s*\d+(?:[,.]\d+)?)?\s*(?:cm|m)?)/gi)].map((match) => match[1]),
      volume: matchFirst(documentText, /(\d+(?:[,.]\d+)?)\s*(m3|m³)/i),
      goods,
      date: matchFirst(documentText, /DATA:\s*([0-9./-]+)/i),
      pickupWindows: documents.map((document) => extractBetween(document.text || '', 'HORARI DE RECOLLIDA:', ['CONTACTE:', 'ADREÇA LLIURAMENT:'])).filter(Boolean),
      deliveryWindows: documents.map((document) => extractBetween(document.text || '', 'HORARI DE LLIURAMENT:', ['CONTACTE:', 'UNITATS'])).filter(Boolean),
      contacts: [...documentText.matchAll(/CONTACTE:?\s*([^:]+?\d{3}\s?\d{3}\s?\d{3})/gi)].map((match) => match[1].trim())
    },
    extractedData: extractedLines,
    instructions: [],
    relevantTariffHints: hints,
    missingData: hints.length ? [] : ['No se han encontrado coincidencias suficientes en el tarifario seleccionado.'],
    warnings: [
      'Analisis local aplicado porque la IA no ha respondido.',
      ...(hasImages ? ['Las imagenes requieren OCR/vision con OpenAI activo para leer el texto de la captura.'] : [])
    ]
  };
}

function buildDocumentInputContent({ clientName, documents, candidateCatalog }) {
  const textDocuments = documents.map((document) => ({
    id: document.id || '',
    fileName: document.fileName,
    text: document.text || '',
    hasImage: Boolean(document.imageData)
  }));
  const userCorrections = textDocuments
    .filter((document) => document.id === 'user-instructions' || /instrucciones escritas/i.test(document.fileName))
    .map((document) => document.text)
    .filter(Boolean);

  const content = [
    {
      type: 'input_text',
      text: JSON.stringify({
        instruccion: 'Analiza la documentacion y devuelve una solicitud logistica estructurada para tarificacion. Las correcciones_usuario tienen prioridad absoluta sobre documentos y albaranes. No calcules importes finales si falta distancia o reglas cerradas.',
        correcciones_usuario: userCorrections,
        datos_ruta: {
          distancia_km: null,
          duracion_estimada_horas: null,
          fuente_distancia: null
        },
        politica_tarificacion: {
          vehiculo: 'segun_tarifario',
          mozo: 'segun_tarifario',
          redondeo_bloques_distancia: 'hacia_arriba',
          redondeo_horas: 'segun_tarifario',
          iva_porcentaje: ivaPercentage,
          permitir_estimacion_peso: true,
          permitir_estimacion_dimensiones: false
        },
        clientName,
        documents: textDocuments,
        tarifario: candidateCatalog ? compactCatalog(candidateCatalog) : null,
        resumen_tarifario_motor: getTariffCatalogSummary()
      })
    }
  ];

  for (const document of documents) {
    if (document.imageData) {
      content.push({
        type: 'input_image',
        image_url: document.imageData
      });
    }
  }

  return content;
}

function removeNullishValues(value) {
  if (Array.isArray(value)) {
    return value.map(removeNullishValues).filter((item) => item !== undefined);
  }

  if (value && typeof value === 'object') {
    const cleaned = {};
    for (const [key, entry] of Object.entries(value)) {
      const cleanedEntry = removeNullishValues(entry);
      if (cleanedEntry !== undefined) {
        cleaned[key] = cleanedEntry;
      }
    }
    return Object.keys(cleaned).length ? cleaned : undefined;
  }

  return value === null || value === '' ? undefined : value;
}

function inferDirectVehicleType(text) {
  const normalized = normalize(text);
  if (/\bmoto\b|mensajeria urbana/.test(normalized)) {
    return 'Moto';
  }
  if (/carrozado|camion/.test(normalized)) {
    return 'Carrozado';
  }
  if (/rigido/.test(normalized)) {
    return 'Rigido';
  }
  if (/furgon|furgoneta|van/.test(normalized)) {
    return 'Furgoneta (ligera)';
  }
  return null;
}

function inferOperationalSurchargesFromText(text, current = null) {
  const normalized = normalize(text);
  const next = { ...(current && typeof current === 'object' ? current : {}) };
  const mentionsShortNotice =
    /\b(hoy|manana|24h|24[\s_]*h|menos[\s_]+de[\s_]+24[\s_]*h?|menos[\s_]+de[\s_]+un[\s_]+dia|para[\s_]+manana)\b/.test(normalized) ||
    (normalized.includes('urgente') && normalized.includes('manana'));
  const mentionsLessThan48h =
    mentionsShortNotice ||
    /\b(48h|48[\s_]*h|menos[\s_]+de[\s_]+48[\s_]*h?|pasado[\s_]+manana|dos[\s_]+dias|2[\s_]+dias)\b/.test(normalized);

  if (mentionsShortNotice) {
    next.requestLessThan24h = true;
    next.requestLessThan48h = false;
  } else if (mentionsLessThan48h && next.requestLessThan24h !== true) {
    next.requestLessThan48h = true;
  } else {
    next.requestLessThan24h = false;
    next.requestLessThan48h = false;
  }

  return Object.keys(next).length > 0 ? next : current;
}

function normalizePricingRequest(pricingRequest, contextText) {
  if (!pricingRequest || typeof pricingRequest !== 'object') {
    return pricingRequest;
  }

  const normalized = { ...pricingRequest };
  const helperKeys = ['ayudante', 'mozo', 'mosso', 'helper'];
  const modalities = Array.isArray(normalized.modality) ? normalized.modality : [];
  const hasHelper = modalities.some((modality) => helperKeys.some((helper) => normalize(modality).includes(helper)));
  normalized.modality = modalities.filter((modality) => !helperKeys.some((helper) => normalize(modality).includes(helper)));
  if (normalized.modality.length === 0) {
    normalized.modality = null;
  }
  if (hasHelper) {
    normalized.mozoCount = normalized.mozoCount ?? 1;
  }

  const literalUrgencyKeys = ['urgente', 'urgent', 'prioritario', 'priority'];
  const cleanedModalities = Array.isArray(normalized.modality)
    ? normalized.modality.filter((modality) => !literalUrgencyKeys.some((key) => normalize(modality).includes(key)))
    : [];
  normalized.modality = cleanedModalities.length > 0 ? cleanedModalities : null;
  normalized.operationalSurcharges = inferOperationalSurchargesFromText(contextText, normalized.operationalSurcharges);

  if (Array.isArray(normalized.routeAddresses)) {
    normalized.routeAddresses = normalized.routeAddresses.map((address) => String(address || '').trim()).filter(Boolean);
    if (normalized.routeAddresses.length === 0) {
      normalized.routeAddresses = null;
    }
  }

  if (Array.isArray(normalized.routeStops)) {
    normalized.routeStops = normalized.routeStops
      .map((stop) => ({
        address: String(stop?.address || '').trim(),
        label: stop?.label ? String(stop.label).trim() : null,
        timeWindowStart: stop?.timeWindowStart ? String(stop.timeWindowStart).trim() : null,
        timeWindowEnd: stop?.timeWindowEnd ? String(stop.timeWindowEnd).trim() : null,
        priority: Number.isFinite(Number(stop?.priority)) ? Number(stop.priority) : null
      }))
      .filter((stop) => stop.address);
    if (normalized.routeStops.length === 0) {
      normalized.routeStops = null;
    }
  }

  if (normalized.routeAddresses?.length) {
    normalized.originAddress = normalized.originAddress || normalized.routeAddresses[0] || null;
    normalized.destinationAddress = normalized.destinationAddress || normalized.routeAddresses[normalized.routeAddresses.length - 1] || null;
    normalized.additionalStops = normalized.additionalStops ?? Math.max(0, normalized.routeAddresses.length - 2);
    normalized.routeStops = normalized.routeStops || normalized.routeAddresses.map((address, index) => ({
      address,
      label: index === 0 ? 'Origen' : index === normalized.routeAddresses.length - 1 ? 'Destino' : `Parada ${index}`,
      timeWindowStart: null,
      timeWindowEnd: null,
      priority: null
    }));
  } else if (normalized.originAddress && normalized.destinationAddress) {
    normalized.routeAddresses = [normalized.originAddress, normalized.destinationAddress];
    normalized.additionalStops = normalized.additionalStops ?? 0;
  }

  if (normalize(normalized.family) === 'directos' && !normalized.vehicleType) {
    normalized.vehicleType = inferDirectVehicleType(contextText);
  }

  return normalized;
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function addFinancialSummary(result) {
  if (!result || typeof result !== 'object') {
    return result;
  }

  const base = roundMoney(result.appliedClientPrice ?? result.recommendedPrice ?? result.referencePrice ?? result.minimumAllowedPrice ?? 0);
  const ivaImporte = roundMoney((base * ivaPercentage) / 100);
  return {
    ...result,
    financialSummary: {
      base_imponible: base,
      iva_porcentaje: ivaPercentage,
      iva_importe: ivaImporte,
      total_con_iva: roundMoney(base + ivaImporte),
      calculatedBy: 'pricing-engine'
    }
  };
}

function sanitizeModelTarification(analysis) {
  if (!analysis?.tarificacion) {
    return analysis;
  }

  const concepts = Array.isArray(analysis.tarificacion.conceptos) ? analysis.tarificacion.conceptos : [];
  const sanitizedConcepts = concepts.map((concept) => {
    if (concept?.calculado_por_codigo) {
      return concept;
    }

    return {
      ...concept,
      precio_unitario: 0,
      importe: 0,
      calculado_por_codigo: false
    };
  });

  return {
    ...analysis,
    tarificacion: {
      ...analysis.tarificacion,
      conceptos: sanitizedConcepts,
      base_imponible: 0,
      iva_porcentaje: ivaPercentage,
      iva_importe: 0,
      total_con_iva: 0
    }
  };
}

function parseAddressParam(value) {
  return String(value || '').trim();
}

function base64Url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function parseServiceAccountJson() {
  if (!googleRouteOptimizationServiceAccountJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(googleRouteOptimizationServiceAccountJson);
    if (!parsed.client_email || !parsed.private_key) {
      return null;
    }

    return {
      clientEmail: parsed.client_email,
      privateKey: String(parsed.private_key).replace(/\\n/g, '\n')
    };
  } catch {
    return null;
  }
}

async function getGoogleRouteOptimizationAccessToken() {
  if (googleRouteOptimizationAccessToken) {
    return googleRouteOptimizationAccessToken;
  }

  if (googleRouteOptimizationTokenCache && googleRouteOptimizationTokenCache.expiresAt > Date.now() + 60000) {
    return googleRouteOptimizationTokenCache.token;
  }

  const serviceAccount = parseServiceAccountJson();
  if (!serviceAccount) {
    throw new Error('Route Optimization no tiene credenciales OAuth configuradas.');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(JSON.stringify({
    iss: serviceAccount.clientEmail,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const unsignedJwt = `${header}.${claim}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsignedJwt);
  signer.end();
  const signature = signer.sign(serviceAccount.privateKey, 'base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const assertion = `${unsignedJwt}.${signature}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || payload?.error || 'No se pudo obtener token OAuth de Google.');
  }

  googleRouteOptimizationTokenCache = {
    token: payload.access_token,
    expiresAt: Date.now() + Math.max(300, Number(payload.expires_in || 3600) - 60) * 1000
  };

  return payload.access_token;
}

async function fetchGoogleDistance(origin, destination) {
  const params = new URLSearchParams({
    origins: origin,
    destinations: destination,
    key: googleMapsApiKey,
    mode: 'driving',
    language: 'es',
    region: 'es',
    units: 'metric'
  });

  const response = await fetch(`${googleDistanceMatrixUrl}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Google Maps respondió con estado HTTP ${response.status}.`);
  }

  const payload = await response.json();
  if (payload.status !== 'OK') {
    throw new Error(`Google Maps devolvió estado ${payload.status}.`);
  }

  const element = payload?.rows?.[0]?.elements?.[0];
  if (!element || element.status !== 'OK') {
    throw new Error(`No se pudo calcular la ruta (${element?.status || 'SIN_RESULTADO'}).`);
  }

  const distanceMeters = Number(element.distance?.value);
  if (!Number.isFinite(distanceMeters)) {
    throw new Error('Google Maps no devolvió una distancia válida.');
  }

  return {
    provider: 'google_maps',
    distanceKm: Math.round((distanceMeters / 1000 + Number.EPSILON) * 10) / 10,
    distanceText: element.distance?.text || `${Math.round(distanceMeters / 1000)} km`,
    durationText: element.duration?.text || '',
    origin: payload?.origin_addresses?.[0] || origin,
    destination: payload?.destination_addresses?.[0] || destination
  };
}

async function fetchGoogleDirectionsRouteDistance(routeAddresses, optimize = false) {
  if (routeAddresses.length < 3) {
    return null;
  }

  const middleAddresses = routeAddresses.slice(1, -1);
  const params = new URLSearchParams({
    origin: routeAddresses[0],
    destination: routeAddresses[routeAddresses.length - 1],
    waypoints: `${optimize ? 'optimize:true|' : ''}${middleAddresses.join('|')}`,
    key: googleMapsApiKey,
    mode: 'driving',
    language: 'es',
    region: 'es',
    units: 'metric'
  });

  const response = await fetch(`${googleDirectionsUrl}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Google Maps respondió con estado HTTP ${response.status}.`);
  }

  const payload = await response.json();
  if (payload.status !== 'OK') {
    throw new Error(`Google Directions devolvió estado ${payload.status}.`);
  }

  const route = payload.routes?.[0];
  const legsPayload = route?.legs ?? [];
  if (!route || legsPayload.length === 0) {
    throw new Error('Google Directions no devolvió una ruta válida.');
  }

  const waypointOrder = Array.isArray(route.waypoint_order) ? route.waypoint_order : [];
  const orderedMiddle = optimize ? waypointOrder.map((index) => routeAddresses[index + 1]).filter(Boolean) : middleAddresses;
  const orderedAddresses = [routeAddresses[0], ...orderedMiddle, routeAddresses[routeAddresses.length - 1]];
  const distanceKm = Math.round((legsPayload.reduce((sum, leg) => sum + Number(leg.distance?.value || 0), 0) / 1000 + Number.EPSILON) * 10) / 10;

  return {
    provider: 'google_maps',
    optimized: Boolean(optimize),
    distanceKm,
    distanceText: `${distanceKm.toLocaleString('es-ES')} km`,
    durationText: legsPayload.map((leg) => leg.duration?.text).filter(Boolean).join(' + '),
    origin: legsPayload[0]?.start_address || orderedAddresses[0],
    destination: legsPayload[legsPayload.length - 1]?.end_address || orderedAddresses[orderedAddresses.length - 1],
    addresses: orderedAddresses,
    waypointOrder,
    legs: legsPayload.map((leg, index) => ({
      provider: 'google_maps',
      distanceKm: Math.round((Number(leg.distance?.value || 0) / 1000 + Number.EPSILON) * 10) / 10,
      distanceText: leg.distance?.text || '',
      durationText: leg.duration?.text || '',
      origin: leg.start_address || orderedAddresses[index],
      destination: leg.end_address || orderedAddresses[index + 1]
    }))
  };
}

async function fetchGoogleGeocode(address) {
  const params = new URLSearchParams({
    address,
    key: googleMapsApiKey,
    language: 'es',
    region: 'es'
  });

  const response = await fetch(`${googleGeocodingUrl}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Google Geocoding respondio con estado HTTP ${response.status}.`);
  }

  const payload = await response.json();
  if (payload.status !== 'OK' || !payload.results?.[0]?.geometry?.location) {
    throw new Error(`Google Geocoding devolvio estado ${payload.status || 'SIN_RESULTADO'}.`);
  }

  const result = payload.results[0];
  return {
    address: result.formatted_address || address,
    location: {
      latitude: Number(result.geometry.location.lat),
      longitude: Number(result.geometry.location.lng)
    }
  };
}

function normalizeRouteOptimizationStops(routeAddresses, stops) {
  const providedStops = Array.isArray(stops) ? stops : [];
  if (providedStops.length > 0) {
    return providedStops
      .map((stop, index) => ({
        address: parseAddressParam(stop?.address || routeAddresses[index]),
        label: parseAddressParam(stop?.label || `Parada ${index + 1}`),
        timeWindowStart: parseAddressParam(stop?.timeWindowStart),
        timeWindowEnd: parseAddressParam(stop?.timeWindowEnd),
        priority: Number.isFinite(Number(stop?.priority)) ? Number(stop.priority) : null
      }))
      .filter((stop) => stop.address);
  }

  return routeAddresses.map((address, index) => ({
    address,
    label: index === 0 ? 'Origen' : index === routeAddresses.length - 1 ? 'Destino' : `Parada ${index}`,
    timeWindowStart: '',
    timeWindowEnd: '',
    priority: null
  }));
}

function timestampFromRouteTime(value, fallbackHour) {
  const raw = parseAddressParam(value);
  if (!raw) {
    return `2026-01-01T${String(fallbackHour).padStart(2, '0')}:00:00Z`;
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    return raw;
  }

  const match = raw.match(/\b([01]?\d|2[0-3])(?::|\.|h)?([0-5]\d)?\b/i);
  if (match) {
    const hour = String(match[1]).padStart(2, '0');
    const minute = String(match[2] || '00').padStart(2, '0');
    return `2026-01-01T${hour}:${minute}:00Z`;
  }

  return `2026-01-01T${String(fallbackHour).padStart(2, '0')}:00:00Z`;
}

async function fetchGoogleRouteOptimization(routeAddresses, stops) {
  if (!googleRouteOptimizationEnabled) {
    throw new Error('Route Optimization API no esta configurada.');
  }

  const normalizedStops = normalizeRouteOptimizationStops(routeAddresses, stops);
  if (normalizedStops.length < 3) {
    return null;
  }

  const geocodedStops = [];
  for (const stop of normalizedStops) {
    const geocoded = await fetchGoogleGeocode(stop.address);
    geocodedStops.push({ ...stop, ...geocoded });
  }

  const origin = geocodedStops[0];
  const destination = geocodedStops[geocodedStops.length - 1];
  const middleStops = geocodedStops.slice(1, -1);
  const accessToken = await getGoogleRouteOptimizationAccessToken();
  const shipments = middleStops.map((stop, index) => {
    const timeWindows = [];
    if (stop.timeWindowStart || stop.timeWindowEnd) {
      timeWindows.push({
        startTime: timestampFromRouteTime(stop.timeWindowStart, 0),
        endTime: timestampFromRouteTime(stop.timeWindowEnd, 23)
      });
    }

    return {
      label: `stop-${index}`,
      deliveries: [{
        arrivalWaypoint: { location: { latLng: stop.location } },
        ...(timeWindows.length ? { timeWindows } : {})
      }],
      penaltyCost: Math.max(1, Number(stop.priority || 1)) * 1000000
    };
  });

  const response = await fetch(`${googleRouteOptimizationUrl}/projects/${encodeURIComponent(googleCloudProjectId)}:optimizeTours`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: {
        globalStartTime: '2026-01-01T00:00:00Z',
        globalEndTime: '2026-01-01T23:59:00Z',
        vehicles: [{
          label: 'vehiculo-1',
          startWaypoint: { location: { latLng: origin.location } },
          endWaypoint: { location: { latLng: destination.location } }
        }],
        shipments
      },
      populatePolylines: false
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Route Optimization respondio con estado HTTP ${response.status}.`);
  }

  const route = payload?.routes?.[0];
  const visits = Array.isArray(route?.visits) ? route.visits : [];
  const orderedMiddle = visits
    .map((visit) => {
      const indexFromLabel = String(visit.shipmentLabel || '').match(/^stop-(\d+)$/)?.[1];
      const index = indexFromLabel !== undefined ? Number(indexFromLabel) : Number(visit.shipmentIndex);
      return middleStops[index];
    })
    .filter(Boolean);
  const orderedStops = [origin, ...orderedMiddle, destination];
  const orderedAddresses = orderedStops.map((stop) => stop.address);
  const metrics = route?.metrics || payload?.metrics || {};
  const distanceMeters = Number(metrics.travelDistanceMeters || metrics.totalDistanceMeters || 0);
  const fallbackDistance = await fetchGoogleRouteDistance(orderedAddresses, { optimize: false });
  const distanceKm = distanceMeters > 0
    ? Math.round((distanceMeters / 1000 + Number.EPSILON) * 10) / 10
    : fallbackDistance.distanceKm;

  return {
    provider: 'google_route_optimization',
    optimized: true,
    advancedOptimized: true,
    distanceKm,
    distanceText: `${distanceKm.toLocaleString('es-ES')} km`,
    durationText: route?.metrics?.travelDuration || fallbackDistance.durationText || '',
    origin: orderedAddresses[0],
    destination: orderedAddresses[orderedAddresses.length - 1],
    addresses: orderedAddresses,
    legs: fallbackDistance.legs || [],
    constraintsApplied: true
  };
}

function shouldUseAdvancedRouteOptimization(routeAddresses, stops, optimize, advanced) {
  if (!advanced || !optimize || routeAddresses.length < 3) {
    return false;
  }

  const normalizedStops = normalizeRouteOptimizationStops(routeAddresses, stops);
  return normalizedStops.some((stop) => stop.timeWindowStart || stop.timeWindowEnd || Number(stop.priority || 0) > 0);
}

async function fetchGoogleRouteDistance(addresses, { optimize = false, stops = null, advanced = false } = {}) {
  const routeAddresses = Array.isArray(addresses)
    ? addresses.map((address) => parseAddressParam(address)).filter(Boolean)
    : [];

  if (routeAddresses.length < 2) {
    throw new Error('La ruta necesita al menos origen y destino.');
  }

  const attemptedAdvancedOptimization = shouldUseAdvancedRouteOptimization(routeAddresses, stops, optimize, advanced);
  if (attemptedAdvancedOptimization) {
    try {
      const optimizedRoute = await fetchGoogleRouteOptimization(routeAddresses, stops);
      if (optimizedRoute) {
        return optimizedRoute;
      }
    } catch (error) {
      console.warn('Route Optimization no disponible, se usa Directions:', error?.message || error);
    }
  }

  const directionsRoute = await fetchGoogleDirectionsRouteDistance(routeAddresses, attemptedAdvancedOptimization ? false : optimize);
  if (directionsRoute) {
    return directionsRoute;
  }

  const legs = [];
  for (let index = 0; index < routeAddresses.length - 1; index += 1) {
    legs.push(await fetchGoogleDistance(routeAddresses[index], routeAddresses[index + 1]));
  }

  const distanceKm = Math.round((legs.reduce((sum, leg) => sum + Number(leg.distanceKm || 0), 0) + Number.EPSILON) * 10) / 10;

  return {
    provider: 'google_maps',
    optimized: false,
    distanceKm,
    distanceText: `${distanceKm.toLocaleString('es-ES')} km`,
    durationText: legs.map((leg) => leg.durationText).filter(Boolean).join(' + '),
    origin: legs[0]?.origin || routeAddresses[0],
    destination: legs[legs.length - 1]?.destination || routeAddresses[routeAddresses.length - 1],
    addresses: routeAddresses,
    legs
  };
}

async function fetchGooglePlacePredictions(input) {
  const params = new URLSearchParams({
    input,
    key: googleMapsApiKey,
    language: 'es',
    region: 'es',
    components: 'country:es'
  });

  const response = await fetch(`${googlePlacesAutocompleteUrl}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Google Places respondió con estado HTTP ${response.status}.`);
  }

  const payload = await response.json();
  if (!['OK', 'ZERO_RESULTS'].includes(payload.status)) {
    throw new Error(`Google Places devolvió estado ${payload.status}.`);
  }

  return {
    provider: 'google_places',
    predictions: (payload.predictions ?? []).slice(0, 6).map((prediction) => ({
      description: prediction.description || '',
      placeId: prediction.place_id || '',
      mainText: prediction.structured_formatting?.main_text || '',
      secondaryText: prediction.structured_formatting?.secondary_text || ''
    })).filter((prediction) => prediction.description && prediction.placeId)
  };
}

async function fetchGooglePlaceDetails(placeId) {
  const params = new URLSearchParams({
    place_id: placeId,
    key: googleMapsApiKey,
    language: 'es',
    fields: 'formatted_address,name,place_id,geometry'
  });

  const response = await fetch(`${googlePlaceDetailsUrl}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Google Place Details respondió con estado HTTP ${response.status}.`);
  }

  const payload = await response.json();
  if (payload.status !== 'OK') {
    throw new Error(`Google Place Details devolvió estado ${payload.status}.`);
  }

  const result = payload.result ?? {};
  return {
    provider: 'google_places',
    placeId: result.place_id || placeId,
    name: result.name || '',
    address: result.formatted_address || result.name || '',
    location: result.geometry?.location || null
  };
}

function calculatePricingRequest(pricingRequest) {
  const cleanedRequest = removeNullishValues(pricingRequest);
  if (!cleanedRequest?.family) {
    return null;
  }

  return addFinancialSummary(calculatePrice(cleanedRequest));
}

function aiUnavailableResponse(res, error, fallbackMessage) {
  const status = error?.status === 401 ? 401 : error?.status === 429 ? 429 : 503;
  const code = error?.code || (status === 401 ? 'invalid_api_key' : status === 429 ? 'insufficient_quota' : 'ai_unavailable');
  const message =
    status === 401
      ? 'OpenAI rechaza la API key configurada. Revisa que .env contenga solo la clave completa, sin texto extra antes o despues.'
      : status === 429
        ? 'OpenAI acepta la API key, pero la cuenta no tiene cuota disponible. Revisa plan, billing o creditos del proyecto.'
      : fallbackMessage;

  res.status(status).json({ error: message, code });
}

app.get('/api/supabase/status', (_req, res) => {
  res.json({ configured: isSupabaseConfigured });
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const supabase = requireSupabaseAdmin();
    const loginCode = String(req.body?.client || '').trim().toLowerCase();
    const pin = String(req.body?.code || '').trim();

    if (!loginCode || !pin) {
      res.status(400).json({ error: 'Faltan cliente y PIN.' });
      return;
    }

    const { data: user, error } = await supabase
      .from('access_users')
      .select('id, name, login_code, pin, role, client_id, can_view_all_tariffs, is_active')
      .eq('login_code', loginCode)
      .eq('pin', pin)
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!user) {
      res.status(401).json({ error: 'Cliente o PIN no válido.' });
      return;
    }

    const allowedCatalogIds = await getAllowedCatalogIdsForClient(supabase, user);
    res.json({ session: mapAccessUser(user, allowedCatalogIds) });
    supabase
      .from('access_users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', user.id)
      .then(({ error }) => {
        if (error) {
          console.warn('No se pudo actualizar last_login_at', error.message);
        }
      });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || 'No se pudo iniciar sesión.' });
  }
});

app.get('/api/admin/access-users', async (_req, res) => {
  try {
    const supabase = requireSupabaseAdmin();
    const { data: users, error } = await supabase
      .from('access_users')
      .select('id, name, login_code, pin, role, client_id, can_view_all_tariffs, is_active')
      .order('created_at', { ascending: true });

    if (error) {
      throw error;
    }

    const mappedUsers = await Promise.all(
      (users ?? []).map(async (user) => mapAccessUser(user, await getAllowedCatalogIdsForClient(supabase, user)))
    );

    res.json({ users: mappedUsers });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || 'No se pudieron cargar usuarios.' });
  }
});

app.put('/api/admin/access-users', async (req, res) => {
  try {
    const supabase = requireSupabaseAdmin();
    const users = Array.isArray(req.body?.users) ? req.body.users : [];

    if (users.length === 0) {
      res.status(400).json({ error: 'No hay usuarios para guardar.' });
      return;
    }

    for (const user of users) {
      await syncAccessUserToSupabase(supabase, user);
    }

    const { data: storedUsers, error } = await supabase
      .from('access_users')
      .select('id, name, login_code, pin, role, client_id, can_view_all_tariffs, is_active')
      .order('created_at', { ascending: true });

    if (error) {
      throw error;
    }

    const mappedUsers = await Promise.all(
      (storedUsers ?? []).map(async (user) => mapAccessUser(user, await getAllowedCatalogIdsForClient(supabase, user)))
    );

    res.json({ users: mappedUsers });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || 'No se pudieron guardar usuarios.' });
  }
});

app.post('/api/analyze-service', async (req, res) => {
  try {
    const { requestText, catalog, clientName } = req.body ?? {};

    if (!requestText || !catalog) {
      res.status(400).json({ error: 'requestText and catalog are required.' });
      return;
    }

    if (!client || !hasUsableApiKey) {
      if (requireRealAi) {
        res.status(503).json({ error: 'OpenAI API key no configurada correctamente.', code: 'missing_api_key' });
        return;
      }
      res.json(buildLocalServiceAnalysis(requestText, catalog, clientName));
      return;
    }

    const candidateCatalog = filterCatalogForRequest(requestText, catalog);

    const response = await client.responses.create({
      model,
      input: [
        {
          role: 'system',
          content: routeAwareTariffAnalysisPrompt
        },
        {
          role: 'user',
          content: JSON.stringify({
            clientName,
            requestText,
            catalog: compactCatalog(candidateCatalog)
          })
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          ...analysisSchema
        }
      }
    });

    const analysis = JSON.parse(response.output_text);
    if (analysis.pricingRequest) {
      try {
        analysis.pricingRequest = normalizePricingRequest(
          analysis.pricingRequest,
          `${requestText}\n${analysis.requestData?.serviceDescription || ''}\n${analysis.summary || ''}`
        );
        analysis.pricingResult = calculatePricingRequest(analysis.pricingRequest);
      } catch (pricingError) {
        analysis.pricingError = {
          message: pricingError?.message || 'No se pudo calcular el precio.',
          details: pricingError?.details || null
        };
      }
    }

    res.json(analysis);
  } catch (error) {
    console.error(error);
    if (requireRealAi) {
      aiUnavailableResponse(res, error, 'OpenAI no ha respondido al analisis.');
      return;
    }
    const { requestText, catalog, clientName } = req.body ?? {};
    if (requestText && catalog) {
      res.json(buildLocalServiceAnalysis(requestText, catalog, clientName));
      return;
    }
    res.status(500).json({ error: 'AI analysis failed.', code: 'ai_analysis_failed' });
  }
});

app.post('/api/pricing/calculate', (req, res) => {
  try {
    const result = calculatePrice(req.body ?? {});
    res.json(addFinancialSummary(result));
  } catch (error) {
    if (error instanceof PricingError) {
      res.status(400).json({
        error: 'pricing_error',
        message: error.message,
        details: error.details || null
      });
      return;
    }

    console.error(error);
    res.status(500).json({
      error: 'pricing_failed',
      message: error?.message || 'No se pudo calcular el precio.'
    });
  }
});

app.get('/api/pricing/summary', (_req, res) => {
  res.json(getTariffCatalogSummary());
});

app.get('/api/maps/status', (_req, res) => {
  res.json({
    provider: 'google_maps',
    distanceEnabled: googleMapsEnabled,
    routeOptimizationEnabled: googleRouteOptimizationEnabled,
    message: googleMapsEnabled
      ? 'Google Maps para cálculo de km está configurado.'
      : 'Google Maps no está configurado. Define GOOGLE_MAPS_API_KEY en .env.'
  });
});

app.get('/api/maps/place-autocomplete', async (req, res) => {
  const input = parseAddressParam(req.query.input);

  if (input.length < 3) {
    res.json({ provider: 'google_places', predictions: [] });
    return;
  }

  if (!googleMapsEnabled) {
    res.status(503).json({
      error: 'maps_not_configured',
      message: 'Google Maps no está configurado en el backend. Define GOOGLE_MAPS_API_KEY en .env.'
    });
    return;
  }

  try {
    res.json(await fetchGooglePlacePredictions(input));
  } catch (error) {
    res.status(502).json({
      error: 'places_provider_error',
      message: error?.message || 'Error al consultar Google Places.'
    });
  }
});

app.get('/api/maps/place-details', async (req, res) => {
  const placeId = parseAddressParam(req.query.placeId);

  if (!placeId) {
    res.status(400).json({
      error: 'bad_request',
      message: 'El parámetro "placeId" es obligatorio.'
    });
    return;
  }

  if (!googleMapsEnabled) {
    res.status(503).json({
      error: 'maps_not_configured',
      message: 'Google Maps no está configurado en el backend. Define GOOGLE_MAPS_API_KEY en .env.'
    });
    return;
  }

  try {
    res.json(await fetchGooglePlaceDetails(placeId));
  } catch (error) {
    res.status(502).json({
      error: 'places_provider_error',
      message: error?.message || 'Error al consultar Google Places.'
    });
  }
});

app.get('/api/maps/distance', async (req, res) => {
  const origin = parseAddressParam(req.query.origin);
  const destination = parseAddressParam(req.query.destination);

  if (!origin || !destination) {
    res.status(400).json({
      error: 'bad_request',
      message: 'Los parámetros "origin" y "destination" son obligatorios.'
    });
    return;
  }

  if (!googleMapsEnabled) {
    res.status(503).json({
      error: 'maps_not_configured',
      message: 'Google Maps no está configurado en el backend. Define GOOGLE_MAPS_API_KEY en .env.'
    });
    return;
  }

  try {
    res.json(await fetchGoogleDistance(origin, destination));
  } catch (error) {
    res.status(502).json({
      error: 'maps_provider_error',
      message: error?.message || 'Error al consultar Google Maps.'
    });
  }
});

app.post('/api/maps/route-distance', async (req, res) => {
  const addresses = req.body?.addresses;
  const optimize = Boolean(req.body?.optimize);
  const advanced = Boolean(req.body?.advanced);
  const stops = req.body?.stops;

  if (!Array.isArray(addresses) || addresses.filter((address) => parseAddressParam(address)).length < 2) {
    res.status(400).json({
      error: 'bad_request',
      message: 'El campo "addresses" debe incluir al menos dos direcciones.'
    });
    return;
  }

  if (!googleMapsEnabled) {
    res.status(503).json({
      error: 'maps_not_configured',
      message: 'Google Maps no está configurado en el backend. Define GOOGLE_MAPS_API_KEY en .env.'
    });
    return;
  }

  try {
    res.json(await fetchGoogleRouteDistance(addresses, { optimize, advanced, stops }));
  } catch (error) {
    res.status(502).json({
      error: 'maps_provider_error',
      message: error?.message || 'Error al consultar Google Maps.'
    });
  }
});

app.post('/api/analyze-document-text', async (req, res) => {
  try {
    const { documents, catalog, clientName } = req.body ?? {};

    if (!Array.isArray(documents) || documents.length === 0) {
      res.status(400).json({ error: 'documents are required.' });
      return;
    }

    if (!client || !hasUsableApiKey) {
      if (requireRealAi) {
        res.status(503).json({ error: 'OpenAI API key no configurada correctamente.', code: 'missing_api_key' });
        return;
      }
      res.json(buildLocalDocumentAnalysis(documents, catalog, clientName));
      return;
    }

    const documentText = documents.map((document) => `${document.fileName}\n${document.text}`).join('\n\n');
    const candidateCatalog = catalog ? filterCatalogForRequest(documentText, catalog) : null;

    const response = await client.responses.create({
      model,
      input: [
        {
          role: 'system',
          content: `${logisticsSystemPrompt} ${logisticsRouteExtractionPrompt}`
        },
        {
          role: 'user',
          content: buildDocumentInputContent({ clientName, documents, candidateCatalog })
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          ...documentSchema
        }
      }
    });

    res.json(sanitizeModelTarification(JSON.parse(response.output_text)));
  } catch (error) {
    console.error(error);
    if (requireRealAi) {
      aiUnavailableResponse(res, error, 'OpenAI no ha respondido al analisis documental.');
      return;
    }
    const { documents, catalog, clientName } = req.body ?? {};
    if (Array.isArray(documents) && documents.length > 0) {
      res.json(buildLocalDocumentAnalysis(documents, catalog, clientName));
      return;
    }
    res.status(500).json({ error: 'Document AI analysis failed.', code: 'document_ai_failed' });
  }
});

app.get('/api/openai-check', async (_req, res) => {
  try {
    if (!client || !hasUsableApiKey) {
      res.status(503).json({
        ok: false,
        model,
        code: 'missing_api_key',
        error: 'OpenAI API key no configurada correctamente.'
      });
      return;
    }

    const response = await client.responses.create({
      model,
      input: 'Responde solo OK'
    });

    res.json({
      ok: response.output_text.trim().toUpperCase().includes('OK'),
      model
    });
  } catch (error) {
    console.error(error);
    aiUnavailableResponse(res, error, 'No se ha podido validar OpenAI.');
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    model,
    apiKeyConfigured: hasUsableApiKey,
    requireRealAi,
    maps: {
      provider: 'google_maps',
      distanceEnabled: googleMapsEnabled,
      routeOptimizationEnabled: googleRouteOptimizationEnabled
    }
  });
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Super Tarifario PLUS API listening on http://127.0.0.1:${port}`);
  });
}

export default app;

