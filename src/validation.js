import mongoose from 'mongoose';
import { DateTime, IANAZone } from 'luxon';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function text(value, field, max, { required = true } = {}) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) {
    throw new ApiError(400, `Invalid ${field}`);
  }
  return value.trim();
}

export function email(value) {
  const result = text(value, 'email', 254).toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i.test(result)) throw new ApiError(400, 'Invalid email');
  return result;
}

export function password(value) {
  if (typeof value !== 'string' || value.length < 8 || Buffer.byteLength(value) > 72) {
    throw new ApiError(400, 'Password must have at least 8 characters and at most 72 bytes');
  }
  return value;
}

export function id(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value) || !mongoose.isValidObjectId(value)) {
    throw new ApiError(400, 'Invalid ID');
  }
  return value;
}

export function campgroundInput(body) {
  const latitude = body.latitude;
  const longitude = body.longitude;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new ApiError(400, 'Valid latitude and longitude are required');
  }
  const timezone = body.timezone ?? 'Asia/Bangkok';
  if (typeof timezone !== 'string' || !IANAZone.isValidZone(timezone)) {
    throw new ApiError(400, 'Invalid IANA timezone');
  }
  return {
    name: text(body.name, 'name', 150),
    address: text(body.address, 'address', 500),
    phone: text(body.phone, 'phone', 30),
    latitude, longitude, timezone,
  };
}

export function bookingDates(checkIn, checkOut, timezone, now = new Date()) {
  if (typeof checkIn !== 'string' || typeof checkOut !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
    throw new ApiError(400, 'Use YYYY-MM-DD for checkIn and checkOut');
  }
  const start = DateTime.fromISO(checkIn, { zone: timezone });
  const end = DateTime.fromISO(checkOut, { zone: timezone });
  const nights = end.diff(start, 'days').days;
  const arrival = start.set({ hour: 14 });
  if (!start.isValid || !end.isValid || !Number.isInteger(nights) || nights < 1 || nights > 3) {
    throw new ApiError(400, 'Bookings must be between 1 and 3 nights');
  }
  if (arrival.toMillis() <= now.getTime()) throw new ApiError(400, 'Check-in must be in the future');
  const reminder = start.minus({ days: 1 }).set({ hour: 9 }).toJSDate();
  return { checkInAt: arrival.toJSDate(), reminderAt: new Date(Math.max(reminder.getTime(), now.getTime())) };
}

export function pagination(query) {
  const page = Number(query.page ?? 1);
  const limit = Number(query.limit ?? 25);
  if (!Number.isInteger(page) || page < 1 || page > 100000
    || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(400, 'Invalid page or limit (maximum 100)');
  }
  return { skip: (page - 1) * limit, limit, page };
}
