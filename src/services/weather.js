import { DateTime } from 'luxon';
import { ApiError } from '../validation.js';

const cache = new Map();

export async function getWeather(campground, date, { fetcher = fetch, now = new Date() } = {}) {
  const today = DateTime.fromJSDate(now, { zone: campground.timezone }).startOf('day');
  const day = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? DateTime.fromISO(date, { zone: campground.timezone }) : null;
  if (!day?.isValid || day < today || day > today.plus({ days: 15 })) {
    throw new ApiError(400, 'Weather forecasts are available from today through the next 15 days');
  }
  const key = [campground.latitude, campground.longitude, campground.timezone, date].join(':');
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now.getTime()) return cached.value;
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: campground.latitude,
    longitude: campground.longitude,
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: campground.timezone,
    start_date: date,
    end_date: date,
  }).toString();
  let data;
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error('Weather provider returned an error');
    data = await response.json();
  } catch {
    throw new ApiError(503, 'Weather provider temporarily unavailable');
  }
  const daily = data.daily;
  if (daily?.time?.[0] !== date
    || ![daily.weather_code?.[0], daily.temperature_2m_min?.[0],
      daily.temperature_2m_max?.[0], daily.precipitation_probability_max?.[0]].every(Number.isFinite)) {
    throw new ApiError(503, 'Weather provider returned incomplete data');
  }
  const value = {
    source: 'Open-Meteo',
    attributionUrl: 'https://open-meteo.com/',
    date,
    timezone: campground.timezone,
    weatherCode: daily.weather_code[0],
    minTemperature: daily.temperature_2m_min[0],
    maxTemperature: daily.temperature_2m_max[0],
    temperatureUnit: '°C',
    precipitationProbability: daily.precipitation_probability_max[0],
  };
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expiresAt: now.getTime() + 15 * 60 * 1000 });
  return value;
}
