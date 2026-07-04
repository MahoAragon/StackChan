/**
 * Server-side tools: capabilities that live in this process rather than on the
 * device. To add one, append an entry in createServerTools() — it shows up in
 * the model's function list next to the device's MCP tools automatically.
 *
 * Keep names in snake_case ([a-zA-Z0-9_-]; OpenAI-compatible servers reject
 * anything else) and descriptions written for the model, not for humans:
 * say when to use the tool, not how it works.
 */
import type { ExecutableTool } from './tool-registry';

/** Config the get_weather tool needs (structurally XiaozhiConfig['weather']). */
export interface WeatherToolConfig {
  defaultLocation: string;
  timezone: string;
}

export function createServerTools(weather: WeatherToolConfig): ExecutableTool[] {
  return [
    {
      name: 'get_current_time',
      description:
        'Get the current date and time (with weekday and timezone). ' +
        'Use whenever the user asks about the time, date, or day.',
      parameters: { type: 'object', properties: {} },
      execute: async () => new Date().toString(),
    },
    {
      name: 'get_weather',
      description:
        'Get the weather forecast (today plus the next several days) for a ' +
        'location. Use whenever the user asks about the weather, temperature, ' +
        'or whether it will rain — including for a specific day such as ' +
        '"today", "tomorrow", or "Friday". Each day in the result is labeled ' +
        'with its weekday and date, and the first day listed is today, so read ' +
        'off the day the user asked about. Omit "location" to use the robot\'s ' +
        'home location.',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description:
              'City name, e.g. "Osaka" or "Kyoto". Leave empty for the ' +
              "robot's home location.",
          },
        },
      },
      execute: (args) => getWeather(args, weather),
    },
  ];
}

// ---------------------------------------------------------------------------
// get_weather implementation (Open-Meteo geocoding + JMA forecast endpoint)
//
// Data source is JMA (Japan's meteorological agency): Open-Meteo's /v1/jma
// endpoint serves JMA's own MSM (~5 km, high-res over Japan) and GSM models —
// keyless for non-commercial use, and higher resolution over Japan than any
// global provider. City names are resolved via Open-Meteo's geocoding API.
// ---------------------------------------------------------------------------

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/jma';
const FORECAST_DAYS = 7;
const HTTP_TIMEOUT_MS = 8000;

interface GeoPlace {
  /** Human/model-readable label, e.g. "Osaka, Osaka, JP". */
  label: string;
  latitude: number;
  longitude: number;
}

/**
 * Geocoding results are cached across sessions (createServerTools runs per
 * connection): a city's coordinates never change, so the common default-location
 * case costs one lookup for the whole process lifetime. Null (not found) is
 * cached too — keyed by the exact query, so a corrected spelling is a new key.
 */
const geoCache = new Map<string, GeoPlace | null>();

async function getWeather(
  args: Record<string, unknown>,
  cfg: WeatherToolConfig,
): Promise<string> {
  const raw = typeof args.location === 'string' ? args.location.trim() : '';
  const location = raw || cfg.defaultLocation;

  const place = await geocode(location);
  if (!place) {
    return `I couldn't find a place called "${location}".`;
  }

  const forecast = await fetchForecast(place, cfg.timezone);
  return formatForecast(place, forecast);
}

async function geocode(name: string): Promise<GeoPlace | null> {
  const key = name.toLowerCase();
  const cached = geoCache.get(key);
  if (cached !== undefined) return cached;

  const url = new URL(GEOCODING_URL);
  url.searchParams.set('name', name);
  url.searchParams.set('count', '1');
  url.searchParams.set('language', 'en');
  url.searchParams.set('format', 'json');

  const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`geocoding service failed (HTTP ${res.status})`);
  const data = (await res.json()) as { results?: GeoResult[] };
  const hit = data.results?.[0];

  const place: GeoPlace | null = hit
    ? {
        label: [hit.name, hit.admin1, hit.country_code]
          .filter(Boolean)
          .join(', '),
        latitude: hit.latitude,
        longitude: hit.longitude,
      }
    : null;
  geoCache.set(key, place);
  return place;
}

async function fetchForecast(
  place: GeoPlace,
  timezone: string,
): Promise<DailyForecast> {
  const url = new URL(FORECAST_URL);
  url.searchParams.set('latitude', String(place.latitude));
  url.searchParams.set('longitude', String(place.longitude));
  url.searchParams.set(
    'daily',
    [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_probability_max',
      'precipitation_sum',
    ].join(','),
  );
  url.searchParams.set('timezone', timezone);
  url.searchParams.set('forecast_days', String(FORECAST_DAYS));

  const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`weather service failed (HTTP ${res.status})`);
  const data = (await res.json()) as { daily?: DailyForecast };
  if (!data.daily?.time?.length) {
    throw new Error('weather service returned no forecast');
  }
  return data.daily;
}

/**
 * One dated line per day so the model can pick the day the user asked about.
 * Written to be read aloud after the model summarizes it, not verbatim.
 */
function formatForecast(place: GeoPlace, daily: DailyForecast): string {
  const lines = daily.time.map((date, i) => {
    const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
    const code = daily.weather_code[i];
    const desc = WMO_DESCRIPTIONS[code] ?? `weather code ${code}`;
    const hi = Math.round(daily.temperature_2m_max[i]);
    const lo = Math.round(daily.temperature_2m_min[i]);
    // JMA exposes precipitation amount (always) but not a probability, so the
    // rain-chance segment only appears if a provider ever supplies it.
    const pop = daily.precipitation_probability_max?.[i];
    const mm = daily.precipitation_sum?.[i];
    const rain = pop != null ? `, rain ${pop}%` : '';
    const amount = mm != null ? `, ${mm}mm rain` : '';
    return `${weekday} ${date}: ${desc}, ${lo}-${hi}°C${rain}${amount}`;
  });

  return (
    `Weather forecast for ${place.label} (source: JMA). ` +
    'Temperatures in °C; "Nmm rain" is expected precipitation (0mm = dry). ' +
    'The first day listed is today.\n' +
    lines.join('\n')
  );
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** WMO weather interpretation codes -> short spoken-friendly descriptions. */
const WMO_DESCRIPTIONS: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Freezing fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Freezing drizzle',
  57: 'Heavy freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Heavy freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light showers',
  81: 'Showers',
  82: 'Violent showers',
  85: 'Snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with heavy hail',
};

interface GeoResult {
  name: string;
  admin1?: string;
  country_code?: string;
  latitude: number;
  longitude: number;
}

interface DailyForecast {
  time: string[];
  weather_code: number[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  precipitation_probability_max?: number[];
  precipitation_sum?: number[];
}
