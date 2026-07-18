# Super Tarifario PLUS

Agente operativo para analizar peticiones logísticas, extraer parámetros tarifables y calcular una propuesta contra el tarifario seleccionado.

## Alcance actual

- Interfaz React/Vite centrada en el agente.
- Tarifarios cargados desde VS Code en `src/data`.
- Selección de tarifario y cliente manual.
- Adjuntos de PDF, DOCX, TXT e imágenes/capturas para análisis.
- Análisis con OpenAI cuando `OPENAI_API_KEY` está configurada.
- Cálculo de kilómetros con Google Maps cuando `GOOGLE_MAPS_API_KEY` está configurada.
- Parámetros editables antes de aprobar el análisis.
- Motor de cálculo separado en `server/pricing/price-engine.cjs`.
- Desglose visible de operaciones y criterio tarifario.

## Tarifarios

La app no carga ni edita tarifarios desde el frontend. Para añadir o modificar un tarifario se actualizan los archivos de datos del proyecto y, si procede, las reglas del motor de cálculo.

Tarifarios actuales:

- `Onus Express 2026`
- `Districenter`

## Variables de entorno

Crea `.env` a partir de `.env.example`:

```bash
OPENAI_API_KEY=sk-proj-your-key-here
OPENAI_MODEL=gpt-4.1-mini
API_PORT=8787
GOOGLE_MAPS_API_KEY=your-google-maps-api-key-here
```

## Comandos

```bash
npm install
npm run dev
npm test
npm run build
```

## Criterios importantes

- La IA extrae y estructura información; el código calcula importes.
- Los kilómetros reales deben venir de Google Maps o de un dato confirmado por el usuario.
- En Districenter, los vehículos se tarifican por tramos de 25 km y los mozos por hora.
- Si faltan datos críticos, la tarifa debe tratarse como pendiente o provisional.
