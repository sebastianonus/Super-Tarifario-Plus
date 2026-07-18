const test = require("node:test");
const assert = require("node:assert/strict");
const { calculatePrice } = require("./price-engine.cjs");

test("mensajeria calcula kg adicional correctamente", () => {
  const result = calculatePrice({
    family: "mensajeria",
    serviceLevel: "48h",
    weightKg: 12,
  });

  assert.equal(result.recommendedPrice, 9.5);
  assert.equal(result.minimumAllowedPrice, 9.5);
  assert.equal(result.clientPriceAccepted, true);
});

test("ultima milla suma recargo por tramo km", () => {
  const result = calculatePrice({
    family: "ultima_milla",
    vehicleType: "Tipo A",
    schedule: "media jornada",
    distanceKm: 150,
  });

  assert.equal(result.recommendedPrice, 100);
});

test("ultima milla devuelve precio unitario por conductor", () => {
  const result = calculatePrice({
    family: "ultima_milla",
    vehicleType: "Tipo A",
    schedule: "media jornada",
    distanceKm: 150,
    driverCount: 2,
  });

  assert.equal(result.recommendedPrice, 190);
  assert.equal(result.unitPricing.mode, "per_driver");
  assert.equal(result.unitPricing.driverCount, 2);
  assert.equal(result.unitPricing.totalPrice, 190);
  assert.equal(result.unitPricing.pricePerDriver, 95);
});

test("ultima milla multiplica precio por dias de servicio", () => {
  const result = calculatePrice({
    family: "ultima_milla",
    vehicleType: "Tipo A",
    schedule: "media jornada",
    distanceKm: 150,
    serviceDays: 3,
  });

  assert.equal(result.recommendedPrice, 300);
});

test("distribucion pallet seco aplica coeficiente por kilo", () => {
  const result = calculatePrice({
    family: "distribucion",
    distributionType: "pallet_seco",
    destination: "nacional",
    weightKg: 300,
  });

  assert.equal(result.referencePrice, 109.12);
});

test("directos con modalidad express", () => {
  const result = calculatePrice({
    family: "directos",
    temperature: "seco",
    vehicleType: "Furgoneta (ligera)",
    distanceKm: 250,
    modality: "express",
  });

  assert.equal(result.recommendedPrice, 330);
});

test("directos ignora modalidad neutra de temperatura", () => {
  const result = calculatePrice({
    family: "directos",
    temperature: "seco",
    vehicleType: "Furgoneta (ligera)",
    distanceKm: 45,
    modality: ["seco"],
  });

  assert.equal(result.recommendedPrice, 65);
});

test("directos aplica ida y vuelta, multi-parada, espera y batching", () => {
  const result = calculatePrice({
    family: "directos",
    temperature: "seco",
    vehicleType: "Furgoneta (ligera)",
    distanceKm: 40,
    roundTrip: true,
    additionalStops: 2,
    waitHours: 1,
    batchedRoute: true,
    batchingDiscountPct: 0.15,
  });

  // Base 65 + ida y vuelta 52 + paradas 40 + espera 20 - batching 9.75 = 167.25
  assert.equal(result.recommendedPrice, 167.25);
});

test("directos Onus incluye mozo con precio manual cuando se informa", () => {
  const result = calculatePrice({
    family: "directos",
    temperature: "seco",
    vehicleType: "Furgoneta (ligera)",
    distanceKm: 40,
    mozoCount: 2,
    mozoManualPrice: 55,
  });

  assert.equal(result.recommendedPrice, 175);
  assert.equal(result.breakdown[1].code, "directo_mozo_manual");
  assert.equal(result.breakdown[1].amount, 110);
});

test("directos no interpreta ayudante como modalidad tarifaria", () => {
  const result = calculatePrice({
    family: "directos",
    temperature: "seco",
    vehicleType: "Furgoneta (ligera)",
    distanceKm: 40,
    modality: ["ayudante"],
    mozoCount: 1,
    mozoManualPrice: 40,
  });

  assert.equal(result.recommendedPrice, 105);
  assert.equal(result.breakdown[1].code, "directo_mozo_manual");
});

test("directos Onus aplica recargo de solicitud con 24h o menos", () => {
  const result = calculatePrice({
    family: "directos",
    temperature: "seco",
    vehicleType: "Furgoneta (ligera)",
    distanceKm: 40,
    operationalSurcharges: {
      requestLessThan24h: true,
    },
  });

  assert.equal(result.recommendedPrice, 97.5);
  assert.equal(result.breakdown[1].code, "supp_solicitud_con_24h_o_menos");
  assert.equal(result.breakdown[1].amount, 32.5);
});

test("directos Onus exige precio manual si hay mozo", () => {
  assert.throws(
    () =>
      calculatePrice({
        family: "directos",
        temperature: "seco",
        vehicleType: "Furgoneta (ligera)",
        distanceKm: 40,
        mozoCount: 1,
      }),
    /importe en euros de mozo/i
  );
});

test("districenter calcula vehiculo por tramos de 25 km y mozo por horas", () => {
  const result = calculatePrice({
    family: "directos",
    tariffId: "districenter",
    vehicleType: "Camión 6,5",
    distanceKm: 358,
    mozoHours: 8,
    mozoCount: 1,
  });

  assert.equal(result.recommendedPrice, 694.5);
  assert.equal(result.breakdown[0].code, "districenter_vehicle_25km_blocks");
  assert.equal(result.breakdown[0].meta.blocks, 15);
  assert.equal(result.breakdown[1].code, "districenter_mozo_hours");
  assert.equal(result.breakdown[1].amount, 147.6);
});

test("districenter no interpreta numeros aislados como camion 8-9", () => {
  const result = calculatePrice({
    family: "directos",
    tariffId: "districenter",
    vehicleType: "3500 con plataforma 2026",
    distanceKm: 25,
  });

  assert.match(result.meta.vehicleType, /Camión 6,5/);
  assert.equal(result.recommendedPrice, 36.46);
});

test("meteor calcula vehiculo, suplemento km y mozo fijo", () => {
  const result = calculatePrice({
    family: "directos",
    tariffId: "meteor",
    vehicleType: "Tipo D (Carrozado con plataforma)",
    distanceKm: 250,
    mozoCount: 1,
  });

  assert.equal(result.recommendedPrice, 360);
  assert.equal(result.breakdown[0].code, "meteor_vehicle_base");
  assert.equal(result.breakdown[1].code, "meteor_km_supplement");
  assert.equal(result.breakdown[2].code, "meteor_mozo_fixed");
});

test("meteor aplica su propia regla aunque la familia sea ultima milla", () => {
  const result = calculatePrice({
    family: "ultima_milla",
    tariffId: "meteor",
    vehicleType: "Tipo B (6 m³ - 2 palets)",
    distanceKm: 26.6,
  });

  assert.equal(result.recommendedPrice, 170);
  assert.equal(result.breakdown[0].code, "meteor_vehicle_base");
});

test("regla de precio minimo bloquea cliente por debajo del minimo", () => {
  const result = calculatePrice({
    family: "mensajeria",
    serviceLevel: "48h",
    weightKg: 3,
    clientPrice: 1,
  });

  assert.equal(result.minimumRule, "below_minimum_rejected");
  assert.equal(result.clientPriceAccepted, false);
});
