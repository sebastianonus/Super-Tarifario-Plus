const tariffData = require("./tariff-data.json");

class PricingError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PricingError";
    this.details = details;
  }
}

function normalizeKey(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function assertPositiveNumber(value, fieldName) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new PricingError(`El campo "${fieldName}" debe ser un número mayor o igual a 0.`, { fieldName, value });
  }
  return num;
}

function haversineKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}

function normalizePoint(input, fieldName) {
  if (!input || typeof input !== "object") {
    throw new PricingError(`El campo "${fieldName}" debe incluir coordenadas.`, { fieldName, input });
  }
  const lat = Number(input.lat ?? input.latitude);
  const lng = Number(input.lng ?? input.lon ?? input.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new PricingError(`El campo "${fieldName}" no tiene coordenadas válidas.`, { fieldName, input });
  }
  return { lat, lng };
}

function resolveDistanceKm(input) {
  if (input.distanceKm !== undefined && input.distanceKm !== null) {
    return { distanceKm: assertPositiveNumber(input.distanceKm, "distanceKm"), source: "input" };
  }

  if (!input.route) {
    return { distanceKm: null, source: "none" };
  }

  const origin = normalizePoint(input.route.origin, "route.origin");
  const destination = normalizePoint(input.route.destination, "route.destination");
  const stops = Array.isArray(input.route.stops)
    ? input.route.stops.map((p, idx) => normalizePoint(p, `route.stops[${idx}]`))
    : [];
  const points = [origin, ...stops, destination];

  let distance = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    distance += haversineKm(points[i], points[i + 1]);
  }

  return { distanceKm: round2(distance), source: "route_coordinates" };
}

function findByKeyOrLabel(collection, value, contextLabel) {
  const target = normalizeKey(value);
  if (!target) {
    throw new PricingError(`Falta el valor para "${contextLabel}".`, { contextLabel, value });
  }
  if (collection[target]) return collection[target];

  for (const [key, item] of Object.entries(collection)) {
    const labelKey = normalizeKey(item.label || item.concept || item.service || key);
    if (target === labelKey || target === key || key.includes(target) || target.includes(key)) {
      return item;
    }
  }

  throw new PricingError(`No se encontró "${value}" en ${contextLabel}.`, {
    contextLabel,
    value,
    available: Object.keys(collection),
  });
}

function findZone(zoneInput, availableZones, contextLabel = "zona") {
  const target = normalizeKey(zoneInput);
  if (!target) {
    throw new PricingError(`Falta el valor de "${contextLabel}".`, { contextLabel, zoneInput });
  }
  const aliases = {
    provincia: ["provincia", "provincial", "provinciales"],
    provincial: ["provincia", "provincial", "provinciales"],
    nacional: ["nacional", "espana", "españa"],
    portugal: ["portugal"],
    baleares: ["baleares"],
    andorra: ["andorra"],
    gibraltar: ["gibraltar"],
    canarias: ["canarias"],
    largo_espana: ["largo_espana", "largoespana", "nacional_largo"],
  };

  for (const zone of availableZones) {
    if (normalizeKey(zone) === target) return zone;
    const aliasList = aliases[zone] || [];
    if (aliasList.some((a) => normalizeKey(a) === target)) return zone;
  }

  throw new PricingError(`Zona "${zoneInput}" no válida para ${contextLabel}.`, { zoneInput, availableZones });
}

function chooseWeightBracket(brackets, weightKg) {
  const ordered = [...brackets].sort((a, b) => a.maxWeightKg - b.maxWeightKg);
  const bracket = ordered.find((item) => weightKg <= item.maxWeightKg);
  return bracket || ordered[ordered.length - 1];
}

function addBreakdown(breakdown, item) {
  breakdown.push({
    code: item.code,
    label: item.label,
    type: item.type || "base",
    amount: round2(item.amount),
    meta: item.meta || null,
  });
}

function sumBreakdown(breakdown) {
  return round2(breakdown.reduce((acc, item) => acc + item.amount, 0));
}

function parseScheduleKey(scheduleInput) {
  const key = normalizeKey(scheduleInput);
  if (!key) {
    throw new PricingError('Falta el campo "schedule" para última milla.');
  }
  if (key.includes("media")) return "media_jornada";
  if (key.includes("completa")) return "jornada_completa";
  if (key.includes("refuerzo")) return "refuerzo_max_3h";
  throw new PricingError(`Franja de jornada no reconocida: "${scheduleInput}".`, { scheduleInput });
}

function parseTemperatureKey(value, defaultValue = "seco") {
  const key = normalizeKey(value || defaultValue);
  if (key.includes("refriger") || key.includes("frio")) return "refrigerado";
  if (key.includes("congel")) return "congelado";
  return "seco";
}

function calculateMensajeria(input) {
  const breakdown = [];
  const catalog = tariffData.mensajeria_distribucion.paqueteria;
  const service = findByKeyOrLabel(
    catalog,
    input.serviceLevel || input.service || input.modalidad,
    "servicio de mensajería"
  );

  if (service.isManualQuote) {
    return {
      family: "mensajeria",
      pricingModel: "range_plus_recommended",
      currency: "EUR",
      status: "quote_required",
      reason: `El servicio "${service.label}" figura como "Consultar" en el tarifario.`,
      minimumAllowedPrice: null,
      recommendedPrice: null,
      suggestedRange: null,
      breakdown,
      meta: {
        serviceLevel: service.label,
      },
    };
  }

  const weightKg = assertPositiveNumber(input.weightKg, "weightKg");
  let basePrice;
  let bracketLabel;
  if (weightKg <= 2) {
    basePrice = service.upto2Kg;
    bracketLabel = "Hasta 2 kg";
  } else if (weightKg <= 5) {
    basePrice = service.upto5Kg;
    bracketLabel = "Hasta 5 kg";
  } else if (weightKg <= 10) {
    basePrice = service.upto10Kg;
    bracketLabel = "Hasta 10 kg";
  } else {
    if (service.additionalKg === null) {
      throw new PricingError(`No existe precio por kg adicional para "${service.label}".`);
    }
    basePrice = service.upto10Kg + (weightKg - 10) * service.additionalKg;
    bracketLabel = "Más de 10 kg";
  }

  addBreakdown(breakdown, {
    code: "mensajeria_base",
    label: `${service.label} (${bracketLabel})`,
    amount: basePrice,
    meta: { weightKg },
  });

  const recommendedPrice = sumBreakdown(breakdown);
  const minPrice = recommendedPrice;
  const maxRangeFactor = Number(input.maxRangeFactor ?? 1.3);
  const suggestedRange = {
    min: round2(minPrice),
    max: round2(minPrice * maxRangeFactor),
  };

  return {
    family: "mensajeria",
    pricingModel: "range_plus_recommended",
    currency: "EUR",
    minimumAllowedPrice: minPrice,
    recommendedPrice,
    suggestedRange,
    breakdown,
    meta: {
      serviceLevel: service.label,
      weightKg,
      bracket: bracketLabel,
    },
  };
}

function calculateUltimaMilla(input) {
  const breakdown = [];
  const temperature = parseTemperatureKey(input.temperature || (input.refrigerated ? "refrigerado" : "seco"));
  const scheduleKey = parseScheduleKey(input.schedule || input.durationType);
  const vehicleCatalog = tariffData.ultima_milla.vehicles[temperature];
  const vehicle = findByKeyOrLabel(vehicleCatalog, input.vehicleType, `vehículos de última milla (${temperature})`);
  const driverCount = Math.max(1, Math.floor(Number(input.driverCount ?? 1)));
  const serviceDays = Math.max(1, Math.floor(Number(input.serviceDays ?? 1)));
  const routeMode = normalizeKey(input.routeMode || input.routeConfig || "puntos_fijos_cliente");
  const fixedStopsCount = Array.isArray(input.fixedStops)
    ? input.fixedStops.map((stop) => String(stop || "").trim()).filter(Boolean).length
    : 0;

  const vehicleBase = vehicle.pricesBySchedule[scheduleKey];
  if (vehicleBase === null || vehicleBase === undefined) {
    throw new PricingError(`No hay precio base para ${vehicle.label} y horario ${scheduleKey}.`, {
      vehicle: vehicle.label,
      scheduleKey,
    });
  }

  addBreakdown(breakdown, {
    code: "ultima_milla_base",
    label: `${vehicle.label} - ${scheduleKey}`,
    amount: vehicleBase * driverCount * serviceDays,
    meta: {
      driverCount,
      serviceDays,
      quantity: serviceDays,
      unitPrice: vehicleBase * driverCount,
      unit: "Servicio",
    },
  });

  const resolvedDistance = resolveDistanceKm(input);
  const distanceKm = resolvedDistance.distanceKm ?? 0;
  const tranches = tariffData.ultima_milla.distanceTranches[temperature];
  const distanceTranche =
    tranches.find((item) => distanceKm >= item.min && (item.max === null || distanceKm <= item.max)) ||
    tranches[tranches.length - 1];
  const distanceSurcharge = distanceTranche ? distanceTranche.price : 0;
  if (distanceSurcharge > 0) {
    addBreakdown(breakdown, {
      code: "ultima_milla_distance",
      label: `Tramo kilometraje (${distanceKm} km)`,
      amount: distanceSurcharge * serviceDays,
      type: "surcharge",
      meta: {
        distanceKm,
        tranche: distanceTranche.raw,
        quantity: serviceDays,
        unitPrice: distanceSurcharge,
        unit: "Recargo",
      },
    });
  }

  const extraHourPrice = tariffData.ultima_milla.extras.find((e) => e.key === "hora_extra")?.price || 0;
  const nightHourPrice = tariffData.ultima_milla.extras.find((e) => e.key === "hora_nocturna")?.price || 0;
  const extraHours = Number(input.extraHours || 0);
  const nightHours = Number(input.nightHours || 0);

  if (extraHours > 0) {
    addBreakdown(breakdown, {
      code: "ultima_milla_extra_hours",
      label: "Horas extra",
      amount: extraHourPrice * extraHours,
      type: "surcharge",
      meta: { extraHours, extraHourPrice },
    });
  }
  if (nightHours > 0) {
    addBreakdown(breakdown, {
      code: "ultima_milla_night_hours",
      label: "Horas nocturnas",
      amount: nightHourPrice * nightHours,
      type: "surcharge",
      meta: { nightHours, nightHourPrice },
    });
  }

  if (Array.isArray(input.qualifiedStaff)) {
    const staffCatalog = {};
    for (const item of tariffData.ultima_milla.qualifiedStaff) {
      staffCatalog[item.key] = item;
    }
    for (const staff of input.qualifiedStaff) {
      const found = findByKeyOrLabel(staffCatalog, staff.type, "personal cualificado");
      const qty = Math.max(1, Number(staff.quantity ?? 1));
      if (found.price !== null) {
        addBreakdown(breakdown, {
          code: `staff_${found.key}`,
          label: found.concept,
          amount: found.price * qty,
          type: "surcharge",
          meta: { quantity: qty, unitPrice: found.price },
        });
      }
    }
  }

  const recommendedPrice = sumBreakdown(breakdown);
  return {
    family: "ultima_milla",
    pricingModel: "recommended_price",
    currency: "EUR",
    minimumAllowedPrice: recommendedPrice,
    recommendedPrice,
    suggestedRange: null,
    breakdown,
    meta: {
      temperature,
      schedule: scheduleKey,
      vehicleType: vehicle.label,
      driverCount,
      serviceDays,
      routeMode,
      fixedStopsCount,
      distanceKm,
      distanceSource: resolvedDistance.source,
    },
  };
}

function calculateDistribucion(input) {
  const type = normalizeKey(input.distributionType || input.type || input.serviceType);
  const breakdown = [];

  if (!type || type === "paqueteria") {
    const mensajeriaResult = calculateMensajeria(input);
    if (mensajeriaResult.status === "quote_required") {
      return {
        ...mensajeriaResult,
        family: "distribucion",
        pricingModel: "reference_price",
      };
    }
    return {
      family: "distribucion",
      pricingModel: "reference_price",
      currency: "EUR",
      minimumAllowedPrice: mensajeriaResult.minimumAllowedPrice,
      referencePrice: mensajeriaResult.recommendedPrice,
      recommendedPrice: mensajeriaResult.recommendedPrice,
      suggestedRange: null,
      breakdown: mensajeriaResult.breakdown,
      meta: {
        ...mensajeriaResult.meta,
        subtype: "paqueteria",
      },
    };
  }

  if (type === "pallet_seco" || type === "pallet" || type === "pallets") {
    const weightKg = assertPositiveNumber(input.weightKg, "weightKg");
    const destination = findZone(
      input.destination,
      ["provincia", "nacional", "baleares", "andorra", "gibraltar", "canarias"],
      "destino pallet seco"
    );
    const bracket = chooseWeightBracket(tariffData.mensajeria_distribucion.palletSecoByWeight, weightKg);
    const rate = bracket.ratesPerKg[destination];
    if (rate === null || rate === undefined) {
      throw new PricingError(`No existe tarifa de pallet seco para destino "${destination}".`);
    }
    const total = round2(rate * weightKg);
    addBreakdown(breakdown, {
      code: "distribucion_pallet_seco",
      label: `Pallet seco - ${destination}`,
      amount: total,
      meta: { ratePerKg: rate, weightKg, bracketMaxKg: bracket.maxWeightKg },
    });

    return {
      family: "distribucion",
      pricingModel: "reference_price",
      currency: "EUR",
      minimumAllowedPrice: total,
      referencePrice: total,
      recommendedPrice: total,
      suggestedRange: null,
      breakdown,
      meta: { subtype: "pallet_seco", destination, weightKg },
    };
  }

  const frioCatalogMap = {
    frio_13_30: tariffData.frio_distribucion.onus_13_30,
    frio_10: tariffData.frio_distribucion.onus_10,
    frio_devoluciones: tariffData.frio_distribucion.devoluciones,
    devoluciones: tariffData.frio_distribucion.devoluciones,
  };
  if (frioCatalogMap[type]) {
    const catalog = frioCatalogMap[type];
    const weightKg = assertPositiveNumber(input.weightKg, "weightKg");
    const zone = findZone(input.destination || input.zone, Object.keys(catalog.brackets[0].prices), "zona frío");
    const bracket = chooseWeightBracket(catalog.brackets, weightKg);
    const highestBracket = catalog.brackets[catalog.brackets.length - 1];
    let price;
    let bracketMeta = { maxWeightKg: bracket.maxWeightKg };
    if (weightKg <= highestBracket.maxWeightKg) {
      price = bracket.prices[zone];
    } else {
      const additionalRate = catalog.additionalKg[zone];
      if (additionalRate === null || additionalRate === undefined) {
        throw new PricingError(`No existe tarifa de kg extra para zona "${zone}".`);
      }
      price = highestBracket.prices[zone] + (weightKg - highestBracket.maxWeightKg) * additionalRate;
      bracketMeta = {
        ...bracketMeta,
        usedAdditionalKgRate: additionalRate,
        thresholdKg: highestBracket.maxWeightKg,
      };
    }
    const total = round2(price);
    addBreakdown(breakdown, {
      code: "distribucion_frio",
      label: `${type} - ${zone}`,
      amount: total,
      meta: { zone, weightKg, ...bracketMeta },
    });

    return {
      family: "distribucion",
      pricingModel: "reference_price",
      currency: "EUR",
      minimumAllowedPrice: total,
      referencePrice: total,
      recommendedPrice: total,
      suggestedRange: null,
      breakdown,
      meta: { subtype: type, zone, weightKg },
    };
  }

  if (type === "frio_bulk" || type === "bulk") {
    const weightKg = assertPositiveNumber(input.weightKg, "weightKg");
    const zone = findZone(
      input.destination || input.zone,
      ["provincia", "nacional", "baleares", "andorra", "gibraltar", "canarias"],
      "zona frío bulk"
    );
    const bracket = chooseWeightBracket(tariffData.frio_distribucion.bulkByKilo, weightKg);
    const rate = bracket.ratesPerKg[zone];
    if (rate === null || rate === undefined) {
      throw new PricingError(`No existe tarifa de frío bulk para zona "${zone}".`);
    }
    const total = round2(rate * weightKg);
    addBreakdown(breakdown, {
      code: "distribucion_frio_bulk",
      label: `Frío bulk - ${zone}`,
      amount: total,
      meta: { ratePerKg: rate, weightKg, bracketMaxKg: bracket.maxWeightKg },
    });

    return {
      family: "distribucion",
      pricingModel: "reference_price",
      currency: "EUR",
      minimumAllowedPrice: total,
      referencePrice: total,
      recommendedPrice: total,
      suggestedRange: null,
      breakdown,
      meta: { subtype: "frio_bulk", zone, weightKg },
    };
  }

  throw new PricingError(`Tipo de distribución no soportado: "${input.distributionType || type}".`, {
    type,
    supported: ["paqueteria", "pallet_seco", "frio_13_30", "frio_10", "frio_devoluciones", "frio_bulk"],
  });
}

function resolveDirectVehicle(temperature, vehicleType) {
  const catalog = tariffData.directos.byTemperature[temperature];
  if (!catalog) {
    throw new PricingError(`Temperatura no válida para directos: "${temperature}"`);
  }
  return findByKeyOrLabel(catalog, vehicleType, `vehículo directo (${temperature})`);
}

function calculateDirectos(input) {
  const breakdown = [];
  let temperature = parseTemperatureKey(input.temperature, "seco");
  if (temperature === "refrigerado") {
    temperature = "frio";
  }
  const distanceKm = assertPositiveNumber(input.distanceKm, "distanceKm");
  const vehicleTypeKey = normalizeKey(input.vehicleType);
  if (!vehicleTypeKey) {
    throw new PricingError('El campo "vehicleType" es obligatorio para directos.');
  }

  let basePrice = 0;
  let vehicleLabel = input.vehicleType;
  let baseMeta = {};

  if (vehicleTypeKey.includes("moto")) {
    if (distanceKm > tariffData.directos.moto.maxDistanceKm) {
      throw new PricingError(
        `El tarifario de moto en directos solo permite hasta ${tariffData.directos.moto.maxDistanceKm} km.`,
        { distanceKm }
      );
    }
    const motoRange =
      tariffData.directos.moto.ranges.find((range) => distanceKm >= range.min && (range.max === null || distanceKm <= range.max)) ||
      tariffData.directos.moto.ranges[tariffData.directos.moto.ranges.length - 1];
    basePrice = motoRange.price;
    vehicleLabel = "Moto (mensajería urbana)";
    baseMeta = { rangeLabel: motoRange.label };
  } else {
    const vehicle = resolveDirectVehicle(temperature, input.vehicleType);
    vehicleLabel = vehicle.label;
    const zone = vehicle.zones.find((z) => distanceKm >= z.min && distanceKm <= z.max);
    if (zone) {
      basePrice = zone.price;
      baseMeta = { zone: `${zone.min}-${zone.max} km` };
    } else {
      const z3 = vehicle.zones[vehicle.zones.length - 1];
      const additionalKm = Math.max(0, distanceKm - z3.max);
      basePrice = z3.price + additionalKm * vehicle.additionalKmPrice;
      baseMeta = { zone: `>${z3.max} km`, additionalKm, additionalKmPrice: vehicle.additionalKmPrice };
    }
  }

  addBreakdown(breakdown, {
    code: "directo_base",
    label: `${vehicleLabel} (${temperature})`,
    amount: basePrice,
    meta: { distanceKm, ...baseMeta },
  });

  const neutralModalityKeys = new Set(["seco", "frio", "refrigerado", "congelado", "ambiental", "normal", "ayudante", "mozo", "mosso", "helper"]);
  const modalityInput = (Array.isArray(input.modality) ? input.modality : input.modality ? [input.modality] : []).filter(
    (modality) => !neutralModalityKeys.has(normalizeKey(modality))
  );
  for (const modality of modalityInput) {
    const found = findByKeyOrLabel(tariffData.directos.modalities, modality, "modalidades de directos");
    const surcharge = basePrice * (found.multiplier || 0);
    addBreakdown(breakdown, {
      code: `directo_modality_${normalizeKey(found.label)}`,
      label: `Recargo ${found.label}`,
      amount: surcharge,
      type: "surcharge",
      meta: { multiplier: found.multiplier },
    });
  }

  const waitHours = Number(input.waitHours || 0);
  if (waitHours > 0) {
    addBreakdown(breakdown, {
      code: "directo_wait",
      label: "Espera extra",
      amount: waitHours * 20,
      type: "surcharge",
      meta: { waitHours, ratePerHour: 20 },
    });
  }

  const mozoCount = Math.max(0, Math.floor(Number(input.mozoCount ?? input.helperCount ?? 0)));
  if (Number.isFinite(mozoCount) && mozoCount > 0) {
    const mozoManualPrice = Number(input.mozoManualPrice ?? input.mozoPrice ?? input.helperPrice ?? 0);
    if (!Number.isFinite(mozoManualPrice) || mozoManualPrice <= 0) {
      throw new PricingError('El importe en euros de mozo/ayudante es obligatorio para directos ONUS.', {
        fieldName: 'mozoManualPrice',
        value: input.mozoManualPrice ?? input.mozoPrice ?? input.helperPrice
      });
    }

    addBreakdown(breakdown, {
      code: "directo_mozo_manual",
      label: "Mozo/ayudante",
      amount: mozoCount * mozoManualPrice,
      type: "surcharge",
      meta: {
        method: "precio manual",
        mozoCount,
        unitPrice: mozoManualPrice,
        unit: "Servicio",
      },
    });
  }

  const additionalStops = Number(input.additionalStops || 0);
  if (additionalStops > 0) {
    const heavyVehicle = /(carrozado|rigido|r[gíi]gido)/i.test(vehicleLabel);
    const rate = heavyVehicle ? 30 : 20;
    addBreakdown(breakdown, {
      code: "directo_additional_stop",
      label: "Puntos adicionales",
      amount: additionalStops * rate,
      type: "surcharge",
      meta: { additionalStops, ratePerStop: rate },
    });
  }

  if (input.roundTrip) {
    addBreakdown(breakdown, {
      code: "directo_round_trip",
      label: "Ida y vuelta (retorno)",
      amount: basePrice * 0.8,
      type: "surcharge",
      meta: { percentage: 0.8 },
    });
  }

  if (input.closedTimeWindow) {
    addBreakdown(breakdown, {
      code: "directo_closed_window",
      label: "Franja horaria cerrada",
      amount: 25,
      type: "surcharge",
    });
  }
  if (input.liftPlatform) {
    addBreakdown(breakdown, {
      code: "directo_lift_platform",
      label: "Plataforma elevadora",
      amount: 30,
      type: "surcharge",
    });
  }
  if (input.secondAttempt) {
    addBreakdown(breakdown, {
      code: "directo_second_attempt",
      label: "Segundo intento de entrega",
      amount: 40,
      type: "surcharge",
    });
  }
  if (input.returnRejected) {
    addBreakdown(breakdown, {
      code: "directo_return_rejected",
      label: "Retorno / no recepción / rechazo",
      amount: basePrice * 0.8,
      type: "surcharge",
      meta: { percentage: 0.8 },
    });
  }
  if (input.ticketCosts) {
    const ticketCosts = assertPositiveNumber(input.ticketCosts, "ticketCosts");
    addBreakdown(breakdown, {
      code: "directo_ticket_costs",
      label: "Peajes / ferries / parkings",
      amount: ticketCosts,
      type: "surcharge",
    });
  }

  if (input.batchedRoute) {
    const rawBatchingPct = Number(input.batchingDiscountPct ?? 0.15);
    const batchingPct = Number.isFinite(rawBatchingPct) ? Math.min(Math.max(rawBatchingPct, 0), 0.5) : 0.15;
    if (batchingPct > 0) {
      addBreakdown(breakdown, {
        code: "directo_batching_discount",
        label: "Descuento ruta agrupada (batching)",
        amount: -basePrice * batchingPct,
        type: "discount",
        meta: { percentage: batchingPct },
      });
    }
  }

  const recommendedPrice = sumBreakdown(breakdown);
  return {
    family: "directos",
    pricingModel: "recommended_price",
    currency: "EUR",
    minimumAllowedPrice: recommendedPrice,
    recommendedPrice,
    suggestedRange: null,
    breakdown,
    meta: { temperature, vehicleType: vehicleLabel, distanceKm },
  };
}

const districenterRates = {
  vehicles: {
    furgoneta: {
      label: "A1. Furgoneta horari 7 a 21",
      day: 19.93,
      night: 26.94,
      urgentDay: 23.91,
      urgentNight: 31.88,
    },
    camio_6_5: {
      label: "A1. Camió 6,5 horari 7 a 21",
      day: 36.46,
      night: 49.22,
      urgentDay: 45.57,
      urgentNight: 58.33,
    },
    camio_8_9: {
      label: "A5. Camió 8-9 horari 7 a 21",
      day: 45.09,
      night: 60.87,
      urgentDay: 56.36,
      urgentNight: 72.15,
    },
    trailer: {
      label: "A9. Tràiler horari 7 a 21",
      day: 52.77,
      night: null,
      urgentDay: null,
      urgentNight: null,
    },
  },
  mozo: {
    day: 18.45,
    night: 24.91,
    urgentDay: 23.06,
    urgentNight: 29.52,
  },
};

function isDistricenterRequest(input) {
  const key = normalizeKey(input.tariffId || input.catalogId || input.tariffName || input.catalogName);
  return key.includes("districenter");
}

function resolveDistricenterVehicle(input) {
  const key = normalizeKey(input.vehicleType);
  if (key.includes("trailer")) return { ...districenterRates.vehicles.trailer, label: "A9. Tráiler horario 7 a 21" };
  if (key.includes("8_9") || key.includes("camio_8") || key.includes("camion_8") || key.includes("rigido")) {
    return { ...districenterRates.vehicles.camio_8_9, label: "A5. Camión 8-9 horario 7 a 21" };
  }
  if (key.includes("camio") || key.includes("camion") || key.includes("carroz") || key.includes("3500") || key.includes("6_5")) {
    return { ...districenterRates.vehicles.camio_6_5, label: "A1. Camión 6,5 horario 7 a 21" };
  }
  return { ...districenterRates.vehicles.furgoneta, label: "A1. Furgoneta horario 7 a 21" };
}

function isNightInput(input) {
  const text = normalizeKey([input.schedule, input.serviceLevel, input.modality, input.notes].flat().filter(Boolean).join(" "));
  return text.includes("21_a_7") || text.includes("noche") || text.includes("nocturno") || text.includes("nit") || text.includes("night");
}

function isUrgentInput(input) {
  const text = normalizeKey([input.serviceLevel, input.modality, input.notes].flat().filter(Boolean).join(" "));
  return text.includes("urgent") || text.includes("urgente") || text.includes("express");
}

function selectDistricenterRate(rateSet, input) {
  const night = isNightInput(input);
  const urgent = isUrgentInput(input);
  const selected = urgent && night ? rateSet.urgentNight : urgent ? rateSet.urgentDay : night ? rateSet.night : rateSet.day;
  return {
    rate: selected ?? rateSet.day,
    scheduleLabel: night ? "horario 21 a 7" : "horario 7 a 21",
    urgencyLabel: urgent ? "urgente" : "programado",
  };
}

function calculateDistricenterDirectos(input) {
  const breakdown = [];
  const distanceKm = assertPositiveNumber(input.distanceKm, "distanceKm");
  const vehicle = resolveDistricenterVehicle(input);
  const vehicleRate = selectDistricenterRate(vehicle, input);
  const blockSizeKm = 25;
  const blocks = Math.max(1, Math.ceil(distanceKm / blockSizeKm));

  addBreakdown(breakdown, {
    code: "districenter_vehicle_25km_blocks",
    label: vehicle.label,
    amount: blocks * vehicleRate.rate,
    meta: {
      tariff: "Districenter",
      method: "vehículo por tramos de 25 km",
      distanceKm,
      blockSizeKm,
      blocks,
      ratePerBlock: vehicleRate.rate,
      schedule: vehicleRate.scheduleLabel,
      urgency: vehicleRate.urgencyLabel,
    },
  });

  const mozoHours = Number(input.mozoHours ?? input.helperHours ?? 0);
  const mozoCount = Math.max(1, Math.floor(Number(input.mozoCount ?? input.helperCount ?? 1)));
  if (Number.isFinite(mozoHours) && mozoHours > 0) {
    const mozoRate = selectDistricenterRate(districenterRates.mozo, input);
    addBreakdown(breakdown, {
      code: "districenter_mozo_hours",
      label: "Mozo",
      amount: mozoHours * mozoCount * mozoRate.rate,
      type: "surcharge",
      meta: {
        tariff: "Districenter",
        method: "mozo por hora",
        mozoHours,
        mozoCount,
        ratePerHour: mozoRate.rate,
        schedule: mozoRate.scheduleLabel,
        urgency: mozoRate.urgencyLabel,
      },
    });
  }

  const recommendedPrice = sumBreakdown(breakdown);
  return {
    family: "directos",
    pricingModel: "recommended_price",
    currency: "EUR",
    minimumAllowedPrice: recommendedPrice,
    recommendedPrice,
    suggestedRange: null,
    breakdown,
    meta: { tariff: "Districenter", vehicleType: vehicle.label, distanceKm, blocks },
    workflowRules: {
      source: "Tarifario Districenter",
      minimumPriceEnforced: true,
      distanceCalculatedFromRoute: true,
      vehicleCalculation: "tramos de 25 km",
      mozoCalculation: "por hora",
    },
  };
}

const meteorRates = {
  vehicles: {
    tipo_a: { label: "Tipo A (3 m³ - 1 palet)", fixed: 160, reinforcement: 80 },
    tipo_b: { label: "Tipo B (6 m³ - 2 palets)", fixed: 170, reinforcement: 90 },
    tipo_c: { label: "Tipo C (12 m³)", fixed: 180, reinforcement: 100 },
    tipo_d: { label: "Tipo D (Carrozado con plataforma)", fixed: 220, reinforcement: 110 },
    tipo_e: { label: "Tipo E (Moto)", fixed: 110, reinforcement: 50 },
    tipo_f: { label: "Tipo F (Bicicleta)", fixed: 90, reinforcement: 40 },
  },
  kmSupplements: [
    { min: 0, max: 50, label: "0 a 50 km", amount: 0 },
    { min: 50, max: 100, label: "50 a 100 km", amount: 5 },
    { min: 100, max: 200, label: "100 a 200 km", amount: 10 },
    { min: 200, max: 300, label: "más de 200 km", amount: 15 },
    { min: 300, max: null, label: "más de 300 km", amount: 20 },
  ],
  extras: {
    nightHour: 5,
    mozoFixed: 125,
    trafficChiefFixed: 160,
    extraHour: 20,
  },
};

function isMeteorRequest(input) {
  const key = normalizeKey(input.tariffId || input.catalogId || input.tariffName || input.catalogName);
  return key.includes("meteor");
}

function resolveMeteorVehicle(input) {
  const key = normalizeKey(input.vehicleType);
  if (key.includes("tipo_f") || key.includes("bicicleta") || key.includes("bici")) return meteorRates.vehicles.tipo_f;
  if (key.includes("tipo_e") || key.includes("moto")) return meteorRates.vehicles.tipo_e;
  if (key.includes("tipo_d") || key.includes("carroz") || key.includes("plataforma") || key.includes("3500")) return meteorRates.vehicles.tipo_d;
  if (key.includes("tipo_c") || key.includes("12")) return meteorRates.vehicles.tipo_c;
  if (key.includes("tipo_b") || key.includes("6") || key.includes("2_palet")) return meteorRates.vehicles.tipo_b;
  return meteorRates.vehicles.tipo_a;
}

function isMeteorReinforcement(input) {
  const text = normalizeKey([input.schedule, input.serviceLevel, input.modality, input.notes].flat().filter(Boolean).join(" "));
  return text.includes("refuerzo") || text.includes("reforc") || text.includes("manana") || text.includes("tarde");
}

function selectMeteorKmSupplement(distanceKm) {
  return (
    meteorRates.kmSupplements.find((range) => distanceKm >= range.min && (range.max === null || distanceKm <= range.max)) ||
    meteorRates.kmSupplements[meteorRates.kmSupplements.length - 1]
  );
}

function calculateMeteorDirectos(input) {
  const breakdown = [];
  const distanceKm = assertPositiveNumber(input.distanceKm ?? 0, "distanceKm");
  const vehicle = resolveMeteorVehicle(input);
  const reinforcement = isMeteorReinforcement(input);
  const vehiclePrice = reinforcement ? vehicle.reinforcement : vehicle.fixed;
  const serviceMode = reinforcement ? "refuerzo mañana/tarde" : "tarifa fija medio día";

  addBreakdown(breakdown, {
    code: "meteor_vehicle_base",
    label: vehicle.label,
    amount: vehiclePrice,
    meta: {
      tariff: "Meteor",
      method: serviceMode,
      vehicleType: vehicle.label,
      rate: vehiclePrice,
    },
  });

  const kmSupplement = selectMeteorKmSupplement(distanceKm);
  if (kmSupplement.amount > 0) {
    addBreakdown(breakdown, {
      code: "meteor_km_supplement",
      label: `Suplemento kilómetros diarios (${kmSupplement.label})`,
      amount: kmSupplement.amount,
      type: "surcharge",
      meta: {
        tariff: "Meteor",
        method: "suplemento fijo por tramo de km diario",
        distanceKm,
        kmRange: kmSupplement.label,
        supplement: kmSupplement.amount,
      },
    });
  }

  const mozoCount = Math.max(0, Math.floor(Number(input.mozoCount ?? input.helperCount ?? 0)));
  if (Number.isFinite(mozoCount) && mozoCount > 0) {
    addBreakdown(breakdown, {
      code: "meteor_mozo_fixed",
      label: "Mozo de almacén",
      amount: mozoCount * meteorRates.extras.mozoFixed,
      type: "surcharge",
      meta: {
        tariff: "Meteor",
        method: "extra tarifa fija",
        mozoCount,
        unitPrice: meteorRates.extras.mozoFixed,
      },
    });
  }

  const trafficChiefCount = Math.max(0, Math.floor(Number(input.trafficChiefCount ?? input.jefeTraficoCount ?? 0)));
  if (Number.isFinite(trafficChiefCount) && trafficChiefCount > 0) {
    addBreakdown(breakdown, {
      code: "meteor_traffic_chief_fixed",
      label: "Jefe de tráfico",
      amount: trafficChiefCount * meteorRates.extras.trafficChiefFixed,
      type: "surcharge",
      meta: {
        tariff: "Meteor",
        method: "extra tarifa fija",
        trafficChiefCount,
        unitPrice: meteorRates.extras.trafficChiefFixed,
      },
    });
  }

  const extraHours = Number(input.extraHours ?? 0);
  if (Number.isFinite(extraHours) && extraHours > 0) {
    addBreakdown(breakdown, {
      code: "meteor_extra_hours",
      label: "Hora extra",
      amount: extraHours * meteorRates.extras.extraHour,
      type: "surcharge",
      meta: {
        tariff: "Meteor",
        method: "hora extra",
        extraHours,
        ratePerHour: meteorRates.extras.extraHour,
      },
    });
  }

  const nightHours = Number(input.nightHours ?? 0);
  if (Number.isFinite(nightHours) && nightHours > 0) {
    addBreakdown(breakdown, {
      code: "meteor_night_hours",
      label: "Hora nocturna",
      amount: nightHours * meteorRates.extras.nightHour,
      type: "surcharge",
      meta: {
        tariff: "Meteor",
        method: "hora nocturna",
        nightHours,
        ratePerHour: meteorRates.extras.nightHour,
      },
    });
  }

  const recommendedPrice = sumBreakdown(breakdown);
  return {
    family: "directos",
    pricingModel: "recommended_price",
    currency: "EUR",
    minimumAllowedPrice: recommendedPrice,
    recommendedPrice,
    suggestedRange: null,
    breakdown,
    meta: { tariff: "Meteor", vehicleType: vehicle.label, distanceKm, serviceMode },
    workflowRules: {
      source: "Tarifario Meteor",
      minimumPriceEnforced: true,
      distanceCalculatedFromRoute: true,
      vehicleCalculation: "tarifa fija/refuerzo medio día",
      kmSupplementCalculation: "suplemento por tramo de kilómetros diarios",
      mozoCalculation: "extra fijo",
    },
  };
}

function calculateAlmacenaje(input) {
  const breakdown = [];
  const temperature = parseTemperatureKey(input.temperature, "seco");
  const sectionKey = normalizeKey(input.section || "almacenaje");
  const quantity = Math.max(1, Number(input.quantity ?? 1));
  let item;
  let sectionLabel = sectionKey;

  if (sectionKey === "inventario" || sectionKey === "inventory") {
    const catalog = {};
    for (const entry of tariffData.almacenaje.inventory) {
      catalog[entry.key] = entry;
    }
    item = findByKeyOrLabel(catalog, input.concept || input.service, "servicios de inventario");
    sectionLabel = "inventario";
  } else {
    const section = tariffData.almacenaje.sections[sectionKey];
    if (!section) {
      throw new PricingError(`Sección de almacenaje no válida: "${input.section}".`, {
        section: input.section,
        supported: Object.keys(tariffData.almacenaje.sections),
      });
    }
    const catalog = {};
    for (const entry of section[temperature]) {
      catalog[entry.key] = entry;
    }
    item = findByKeyOrLabel(catalog, input.concept, `almacenaje/${sectionKey}/${temperature}`);
  }

  if (item.price === null || item.price === undefined) {
    return {
      family: "almacenaje",
      pricingModel: "reference_price",
      currency: "EUR",
      status: "quote_required",
      reason: `El concepto "${item.concept || item.service}" figura como "Consultar".`,
      minimumAllowedPrice: null,
      referencePrice: null,
      recommendedPrice: null,
      breakdown,
      meta: { section: sectionLabel, temperature, concept: item.concept || item.service },
    };
  }

  addBreakdown(breakdown, {
    code: "almacenaje_base",
    label: item.concept || item.service,
    amount: item.price * quantity,
    meta: { unit: item.unit, unitPrice: item.price, quantity, section: sectionLabel, temperature },
  });

  if (sectionLabel === "inventario") {
    const urgentPct = tariffData.almacenaje.inventory.find((i) => i.key.includes("inventario_urgente"))?.price || 0;
    const weekendPct = tariffData.almacenaje.inventory.find((i) => i.key.includes("inventario_fin_de_semana"))?.price || 0;
    if (input.inventoryUrgent) {
      const currentBase = sumBreakdown(breakdown);
      addBreakdown(breakdown, {
        code: "almacenaje_inventory_urgent",
        label: "Recargo inventario urgente",
        amount: currentBase * urgentPct,
        type: "surcharge",
        meta: { percentage: urgentPct },
      });
    }
    if (input.inventoryWeekend) {
      const currentBase = sumBreakdown(breakdown);
      addBreakdown(breakdown, {
        code: "almacenaje_inventory_weekend",
        label: "Recargo inventario fin de semana",
        amount: currentBase * weekendPct,
        type: "surcharge",
        meta: { percentage: weekendPct },
      });
    }
  }

  const referencePrice = sumBreakdown(breakdown);
  return {
    family: "almacenaje",
    pricingModel: "reference_price",
    currency: "EUR",
    minimumAllowedPrice: referencePrice,
    referencePrice,
    recommendedPrice: referencePrice,
    suggestedRange: null,
    breakdown,
    meta: {
      section: sectionLabel,
      temperature,
      concept: item.concept || item.service,
      quantity,
      unit: item.unit,
    },
  };
}

function applyOperationalSurcharges(baseResult, operationalInput) {
  if (!operationalInput || typeof operationalInput !== "object") {
    return baseResult;
  }

  if (baseResult.status === "quote_required") {
    return baseResult;
  }

  const breakdown = [...baseResult.breakdown];
  const baseForPercent = baseResult.referencePrice ?? baseResult.recommendedPrice ?? 0;

  function addPercentSurcharge(flag, supplementKey, labelFallback, meta = {}) {
    if (!flag) return;
    const supplement = tariffData.operational_supplements[supplementKey];
    const pct = supplement?.percentages?.[0];
    if (!pct) return;
    addBreakdown(breakdown, {
      code: `supp_${supplementKey}`,
      label: supplement?.label || labelFallback,
      amount: baseForPercent * pct,
      type: "surcharge",
      meta: { percentage: pct, ...meta },
    });
  }

  addPercentSurcharge(operationalInput.emptyDeparture, "salida_sin_mercancia_no_cargar", "Salida sin mercancía");
  addPercentSurcharge(operationalInput.requestLessThan48h, "solicitud_con_48h", "Solicitud con <48h");
  addPercentSurcharge(operationalInput.requestLessThan24h, "solicitud_con_24h_o_menos", "Solicitud con <=24h");
  addPercentSurcharge(operationalInput.sporadicRoute, "ruta_esporadica_1_semana", "Ruta esporádica");
  addPercentSurcharge(operationalInput.changePointConditions, "cambio_de_punto_condiciones", "Cambio de punto/condiciones");
  addPercentSurcharge(operationalInput.secondAttemptPenalty, "segundo_intento_por_ausencia_rechazo", "Segundo intento");

  const waitBlocks = Number(operationalInput.waitBlocks30m || 0);
  if (waitBlocks > 0) {
    const supplement = tariffData.operational_supplements.espera_en_carga_descarga;
    const pct = supplement?.percentages?.[0] || 0;
    addBreakdown(breakdown, {
      code: "supp_wait_blocks",
      label: supplement?.label || "Espera en carga/descarga",
      amount: baseForPercent * pct * waitBlocks,
      type: "surcharge",
      meta: { percentage: pct, waitBlocks30m: waitBlocks },
    });
  }

  if (operationalInput.cancellationHoursBefore !== undefined && operationalInput.cancellationHoursBefore !== null) {
    const hours = Number(operationalInput.cancellationHoursBefore);
    const supplement = tariffData.operational_supplements.cancelacion_tardia;
    if (Number.isFinite(hours) && supplement?.percentages?.length) {
      let pct = 0;
      if (hours <= 24) pct = supplement.percentages[0] || 0;
      else if (hours <= 48) pct = supplement.percentages[1] || 0;
      if (pct > 0) {
        addBreakdown(breakdown, {
          code: "supp_cancelacion_tardia",
          label: supplement.label || "Cancelación tardía",
          amount: baseForPercent * pct,
          type: "surcharge",
          meta: { percentage: pct, cancellationHoursBefore: hours },
        });
      }
    }
  }

  const total = sumBreakdown(breakdown);
  const updated = {
    ...baseResult,
    breakdown,
    minimumAllowedPrice: round2(
      (baseResult.minimumAllowedPrice || 0) + (total - (baseResult.recommendedPrice ?? baseResult.referencePrice ?? 0))
    ),
  };

  if (updated.referencePrice !== undefined) updated.referencePrice = total;
  if (updated.recommendedPrice !== undefined) updated.recommendedPrice = total;
  if (updated.suggestedRange) {
    const previous = baseResult.recommendedPrice ?? baseResult.referencePrice ?? 0;
    const diff = total - previous;
    updated.suggestedRange = {
      min: round2((updated.suggestedRange.min || 0) + diff),
      max: round2((updated.suggestedRange.max || 0) + diff),
    };
  }

  return updated;
}

function applyClientPriceRules(result, clientPrice) {
  if (result.status === "quote_required") {
    return {
      ...result,
      clientPriceAccepted: false,
      appliedClientPrice: null,
      clientPrice,
      minimumRule: "quote_required",
    };
  }

  const reference = result.referencePrice ?? result.recommendedPrice;
  const minimum = result.minimumAllowedPrice ?? reference;
  if (clientPrice === null || clientPrice === undefined) {
    return {
      ...result,
      clientPrice: null,
      clientPriceAccepted: true,
      appliedClientPrice: reference,
      minimumRule: "ok",
    };
  }

  const numericClientPrice = assertPositiveNumber(clientPrice, "clientPrice");
  const accepted = numericClientPrice >= minimum;
  return {
    ...result,
    clientPrice: round2(numericClientPrice),
    clientPriceAccepted: accepted,
    appliedClientPrice: accepted ? round2(numericClientPrice) : round2(reference),
    minimumRule: accepted ? "ok" : "below_minimum_rejected",
  };
}

function enrichUltimaMillaUnitPricing(result, request) {
  if (!result || result.family !== "ultima_milla" || result.status === "quote_required") {
    return result;
  }

  const rawDriverCount = Number(request?.driverCount ?? result?.meta?.driverCount ?? 1);
  const driverCount = Math.max(1, Math.floor(Number.isFinite(rawDriverCount) ? rawDriverCount : 1));
  const totalPrice = round2(result.appliedClientPrice ?? result.recommendedPrice ?? result.referencePrice ?? 0);
  const minimumTotalPrice = round2(result.minimumAllowedPrice ?? totalPrice);
  const pricePerDriver = round2(totalPrice / driverCount);
  const minimumPerDriverPrice = round2(minimumTotalPrice / driverCount);

  return {
    ...result,
    unitPricing: {
      mode: "per_driver",
      driverCount,
      totalPrice,
      minimumTotalPrice,
      pricePerDriver,
      minimumPerDriverPrice,
    },
    meta: {
      ...(result.meta || {}),
      driverCount,
    },
  };
}

function normalizeFamily(familyInput) {
  const key = normalizeKey(familyInput);
  if (!key) throw new PricingError('Falta el campo obligatorio "family".');
  if (key.includes("mensaj")) return "mensajeria";
  if (key.includes("ultima") || key === "um") return "ultima_milla";
  if (key.includes("distrib")) return "distribucion";
  if (key.includes("direct")) return "directos";
  if (key.includes("almacen")) return "almacenaje";
  throw new PricingError(`Familia de cálculo no soportada: "${familyInput}".`, {
    supportedFamilies: ["mensajeria", "ultima_milla", "distribucion", "directos", "almacenaje"],
  });
}

function calculatePrice(request) {
  if (!request || typeof request !== "object") {
    throw new PricingError("La solicitud de cálculo debe ser un objeto JSON.");
  }

  const family = normalizeFamily(request.family);
  let baseResult;
  if (isMeteorRequest(request)) {
    baseResult = calculateMeteorDirectos(request);
  } else {
  switch (family) {
    case "mensajeria":
      baseResult = calculateMensajeria(request);
      break;
    case "ultima_milla":
      baseResult = calculateUltimaMilla(request);
      break;
    case "distribucion":
      baseResult = calculateDistribucion(request);
      break;
    case "directos":
      baseResult = isDistricenterRequest(request) ? calculateDistricenterDirectos(request) : calculateDirectos(request);
      break;
    case "almacenaje":
      baseResult = calculateAlmacenaje(request);
      break;
    default:
      throw new PricingError(`Familia no implementada: ${family}`);
  }
  }

  const withOperationalSurcharges = applyOperationalSurcharges(baseResult, request.operationalSurcharges);
  const withClientRules = applyClientPriceRules(withOperationalSurcharges, request.clientPrice);
  const enrichedResult =
    family === "ultima_milla" ? enrichUltimaMillaUnitPricing(withClientRules, request) : withClientRules;

  return {
    ...enrichedResult,
    family,
    tariffVersion: tariffData.metadata.generatedAt,
    workflowRules: enrichedResult.workflowRules || tariffData.rules.pricingCore,
  };
}

function getTariffCatalogSummary() {
  return {
    metadata: tariffData.metadata,
    families: {
      mensajeria: {
        serviceLevels: Object.values(tariffData.mensajeria_distribucion.paqueteria).map((item) => item.label),
      },
      ultima_milla: {
        schedules: tariffData.ultima_milla.schedules,
        vehicles: {
          seco: Object.values(tariffData.ultima_milla.vehicles.seco).map((v) => v.label),
          refrigerado: Object.values(tariffData.ultima_milla.vehicles.refrigerado).map((v) => v.label),
        },
      },
      distribucion: {
        supportedTypes: ["paqueteria", "pallet_seco", "frio_13_30", "frio_10", "frio_devoluciones", "frio_bulk"],
      },
      directos: {
        temperatures: Object.keys(tariffData.directos.byTemperature),
        modalities: Object.values(tariffData.directos.modalities).map((m) => m.label),
      },
      almacenaje: {
        sections: Object.keys(tariffData.almacenaje.sections),
      },
    },
  };
}

module.exports = {
  PricingError,
  calculatePrice,
  getTariffCatalogSummary,
};
