import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import { DateTime } from 'luxon';
import { createApp } from '../src/app.js';
import { User, Campground, Booking } from '../src/models.js';
import { bookingDates } from '../src/validation.js';
import { deliverNext } from '../src/services/notifications.js';
import { getWeather } from '../src/services/weather.js';

process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters';
process.env.JWT_EXPIRES_IN = '1d';
const app = createApp();
let mongo;
let campground;
let alice;
let bob;
let admin;
let bookingId;
const future = days => DateTime.now().setZone('Asia/Bangkok').plus({ days }).toISODate();
const send = (method, path, token) => {
  const req = request(app)[method]('/api/v1' + path);
  return token ? req.set('Authorization', 'Bearer ' + token) : req;
};

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('butterbear-test'));
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
  campground = await Campground.create({
    name: 'Test campground', address: 'Test address', phone: '0800000000',
    latitude: 14.439, longitude: 101.372, timezone: 'Asia/Bangkok',
  });
  const a = await send('post', '/auth/register').send({
    name: 'Alice', phone: '0800000001', email: 'alice@example.test', password: 'test-password-123', role: 'admin',
  });
  assert.equal(a.status, 201);
  assert.equal(a.body.data.role, 'user');
  assert.equal(a.body.data.password, undefined);
  alice = a.body.token;
  const b = await send('post', '/auth/register').send({
    name: 'Bob', phone: '0800000002', email: 'bob@example.test', password: 'test-password-123',
  });
  bob = b.body.token;
  await User.create({
    name: 'Admin', phone: '0800000003', email: 'admin@example.test',
    password: await bcrypt.hash('test-password-123', 4), role: 'admin',
  });
  const result = await send('post', '/auth/login').send({ email: 'admin@example.test', password: 'test-password-123' });
  admin = result.body.token;
});
after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

test('authentication rejects injection, duplicates and anonymous mutations', async () => {
  assert.equal((await send('post', '/auth/login').send({
    email: { $ne: null }, password: 'test-password-123',
  })).status, 400);
  assert.equal((await send('post', '/auth/register').send({
    name: 'Duplicate', phone: '0800000000', email: 'ALICE@example.test', password: 'test-password-123',
  })).status, 409);
  assert.equal((await send('post', '/bookings').send({})).status, 401);
  assert.equal((await send('post', '/campgrounds', alice).send({})).status, 403);
});

test('favorites remain unique during concurrent additions and removals are idempotent', async () => {
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    send('put', '/favorites/' + campground.id, alice)));
  assert.ok(results.every(r => r.status === 200));
  const list = await send('get', '/favorites', alice);
  assert.equal(list.body.count, 1);
  assert.equal((await send('get', '/favorites', bob)).body.count, 0);
  assert.equal((await send('delete', '/favorites/' + campground.id, alice)).status, 200);
  assert.equal((await send('delete', '/favorites/' + campground.id, alice)).status, 200);
  assert.equal((await send('get', '/favorites', alice)).body.count, 0);
});

test('booking date rules count calendar nights across daylight saving changes', () => {
  const now = new Date('2027-01-01T00:00:00Z');
  assert.doesNotThrow(() => bookingDates('2027-03-13', '2027-03-16', 'America/New_York', now));
  assert.throws(() => bookingDates('2027-03-13', '2027-03-17', 'America/New_York', now), /1 and 3/);
  assert.throws(() => bookingDates('2027-02-30', '2027-03-01', 'Asia/Bangkok', now));
  assert.throws(() => bookingDates('2027-03-13', '2027-03-13', 'Asia/Bangkok', now));
});

test('booking creation validates dates, ownership and persists email jobs atomically', async () => {
  const input = { campground: campground.id, checkIn: future(2), checkOut: future(5), specialRequest: 'Quiet pitch please' };
  assert.equal((await send('post', '/bookings', alice).send({ ...input, checkOut: future(6) })).status, 400);
  const result = await send('post', '/bookings', alice).send(input);
  assert.equal(result.status, 201);
  assert.equal(result.body.emailStatus, 'queued');
  assert.equal(result.body.data.specialRequest, input.specialRequest);
  assert.equal(result.body.data.notifications, undefined);
  bookingId = result.body.data._id;
  const booking = await Booking.findById(bookingId).select('+notifications');
  assert.equal(booking.notifications.length, 2);
  assert.equal(booking.notifications[0].type, 'confirmation');
  assert.equal(booking.notifications[1].type, 'reminder');
  assert.equal((await send('get', '/bookings/' + bookingId, bob)).status, 404);
  assert.equal((await send('patch', '/bookings/' + bookingId, bob).send({ specialRequest: 'hijack' })).status, 404);
  assert.equal((await send('delete', '/bookings/' + bookingId, bob)).status, 404);
  assert.equal((await send('get', '/bookings/' + bookingId + '/notifications', bob)).status, 404);
  assert.equal((await send('get', '/bookings', bob)).body.count, 0);
  assert.equal((await send('get', '/bookings', admin)).body.count, 1);
});

test('an admin edit emails the booking owner and supersedes the old reminder', async () => {
  const response = await send('patch', '/bookings/' + bookingId, admin).send({ specialRequest: 'Near the restroom' });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.revision, 2);
  const booking = await Booking.findById(bookingId).select('+notifications');
  assert.equal(booking.notifications[2].type, 'update');
  assert.equal(booking.notifications[2].recipient, 'alice@example.test');
  assert.equal(booking.notifications[3].snapshot.specialRequest, 'Near the restroom');
});

test('concurrent workers claim each confirmation or edit notification only once', async () => {
  const messages = [];
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const mailer = { preview: true, transport: { sendMail: async message => {
    messages.push(message);
    return transport.sendMail(message);
  } } };
  await Promise.all([deliverNext(mailer), deliverNext(mailer), deliverNext(mailer)]);
  assert.equal(messages.length, 2);
  assert.ok(messages.every(m => m.to === 'alice@example.test'));
  const booking = await Booking.findById(bookingId).select('+notifications');
  assert.equal(booking.notifications.filter(n => n.status === 'preview').length, 2);
  assert.ok(messages.some(m => m.subject.includes('Booking updated')));
});

test('reminder fetches external weather for check-in and includes it in the email', async () => {
  const booking = await Booking.findById(bookingId).select('+notifications');
  const reminder = booking.notifications.find(n => n.type === 'reminder' && n.revision === 2);
  const now = new Date(reminder.scheduledAt.getTime() + 1000);
  const messages = [];
  const mailer = { preview: false, transport: { sendMail: async message => {
    messages.push(message);
    return { messageId: message.messageId, accepted: [message.to] };
  } } };
  const weather = async (snapshot, date) => {
    assert.equal(snapshot.latitude, campground.latitude);
    assert.equal(date, booking.checkIn);
    return { minTemperature: 19, maxTemperature: 27, precipitationProbability: 40, weatherCode: 3 };
  };
  // First the obsolete reminder is consumed without sending.
  await deliverNext(mailer, { now, weather });
  await deliverNext(mailer, { now, weather });
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /19 to 27/);
  assert.match(messages[0].text, /Rain probability: 40%/);
  assert.match(messages[0].text, /Open-Meteo/);
});

test('SMTP failures persist a retry without losing a booking or sending after cancellation', async () => {
  const result = await send('post', '/bookings', alice).send({
    campground: campground.id, checkIn: future(3), checkOut: future(4),
  });
  const id = result.body.data._id;
  const now = new Date();
  await deliverNext({ transport: { sendMail: async () => { throw new Error('offline'); } } }, { now });
  const booking = await Booking.findById(id).select('+notifications');
  assert.equal(booking.status, 'active');
  assert.equal(booking.notifications[0].status, 'pending');
  assert.equal(booking.notifications[0].attempts, 1);
  await send('delete', '/bookings/' + id, alice);
  let sent = false;
  await deliverNext({ transport: { sendMail: async () => { sent = true; } } }, { now: new Date(now.getTime() + 120000) });
  assert.equal(sent, false);
  assert.equal((await send('get', '/bookings/' + id, alice)).status, 404);
});

test('weather request uses the external API and handles unavailable forecasts', async () => {
  const now = new Date();
  const date = future(1);
  const value = await getWeather(campground, date, { now, fetcher: async url => {
    assert.equal(url.hostname, 'api.open-meteo.com');
    assert.equal(url.searchParams.get('start_date'), date);
    return { ok: true, json: async () => ({ daily: {
      time: [date], weather_code: [3], temperature_2m_min: [18],
      temperature_2m_max: [28], precipitation_probability_max: [25],
    } }) };
  } });
  assert.equal(value.source, 'Open-Meteo');
  assert.equal(value.precipitationProbability, 25);
  await assert.rejects(getWeather(campground, future(30)), /15 days/);
  await assert.rejects(getWeather(campground, future(4), {
    fetcher: async () => { throw new Error('timeout'); },
  }), /temporarily unavailable/);
});

test('logout invalidates the current bearer token while retaining another login session', async () => {
  const second = await send('post', '/auth/login').send({ email: 'alice@example.test', password: 'test-password-123' });
  assert.equal((await send('post', '/auth/logout', alice)).status, 200);
  assert.equal((await send('get', '/auth/me', alice)).status, 401);
  assert.equal((await send('get', '/auth/me', second.body.token)).status, 200);
});
