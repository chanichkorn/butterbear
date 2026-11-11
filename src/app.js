import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { DateTime } from 'luxon';
import { User, Session, Campground, Booking } from './models.js';
import { authenticate, admin, bookingOwner, issueSession } from './auth.js';
import { ApiError, text, email, password, id, campgroundInput, bookingDates, pagination } from './validation.js';
import { notificationJobs } from './services/mail.js';
import { getWeather } from './services/weather.js';

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const auth = asyncRoute(authenticate);

async function activeCampground(campgroundId) {
  const campground = await Campground.findOne({ _id: id(campgroundId), active: true });
  if (!campground) throw new ApiError(404, 'Campground not found');
  return campground;
}

function publicBooking(booking) {
  const result = booking.toObject();
  delete result.notifications;
  delete result.__v;
  return result;
}

function notifyInput(booking, campground, dates, type, revision, recipient) {
  return notificationJobs({
    type, revision, recipient,
    campground, checkIn: booking.checkIn, checkOut: booking.checkOut,
    specialRequest: booking.specialRequest,
    reminderAt: dates.reminderAt,
  });
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Set only when deployed behind exactly one trusted reverse proxy (e.g. Beanstalk).
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '20kb' }));
  app.use('/api', rateLimit({
    windowMs: 10 * 60 * 1000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false,
  }));

  app.get('/health', (_req, res) => res.json({ success: true }));
  app.get('/', (_req, res) => res.json({ name: 'Butterbear', api: '/api/v1' }));

  const api = express.Router();
  app.use('/api/v1', api);

  api.post('/auth/register', asyncRoute(async (req, res) => {
    const user = await User.create({
      name: text(req.body.name, 'name', 100),
      phone: text(req.body.phone, 'phone', 30),
      email: email(req.body.email),
      password: await bcrypt.hash(password(req.body.password), 12),
      role: 'user',
    });
    const token = await issueSession(user);
    res.status(201).json({ success: true, token, data: user });
  }));

  api.post('/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 }), asyncRoute(async (req, res) => {
    const address = email(req.body.email);
    const secret = password(req.body.password);
    const user = await User.findOne({ email: address }).select('+password');
    if (!user || !await bcrypt.compare(secret, user.password)) {
      throw new ApiError(401, 'Invalid credentials');
    }
    const token = await issueSession(user);
    res.json({ success: true, token, data: user });
  }));
  api.get('/auth/me', auth, (req, res) => res.json({ success: true, data: req.user }));
  api.post('/auth/logout', auth, asyncRoute(async (req, res) => {
    await Session.deleteOne({ _id: req.sessionId, user: req.user._id });
    res.json({ success: true, message: 'Logged out' });
  }));

  api.get('/campgrounds', asyncRoute(async (req, res) => {
    const { skip, limit, page } = pagination(req.query);
    const [data, total] = await Promise.all([
      Campground.find({ active: true }).sort({ name: 1, _id: 1 }).skip(skip).limit(limit),
      Campground.countDocuments({ active: true }),
    ]);
    res.json({ success: true, count: data.length, total, page, data });
  }));
  api.get('/campgrounds/:id/weather', asyncRoute(async (req, res) => {
    const campground = await activeCampground(req.params.id);
    const date = req.query.date ?? DateTime.now().setZone(campground.timezone).toISODate();
    res.json({ success: true, data: await getWeather(campground, date) });
  }));
  api.get('/campgrounds/:id', asyncRoute(async (req, res) => {
    res.json({ success: true, data: await activeCampground(req.params.id) });
  }));
  api.post('/campgrounds', auth, admin, asyncRoute(async (req, res) => {
    const data = await Campground.create(campgroundInput(req.body));
    res.status(201).json({ success: true, data });
  }));
  api.put('/campgrounds/:id', auth, admin, asyncRoute(async (req, res) => {
    const current = await activeCampground(req.params.id);
    const data = await Campground.findOneAndUpdate({ _id: current._id, active: true },
      { $set: campgroundInput(req.body) }, { new: true, runValidators: true });
    if (!data) throw new ApiError(409, 'Campground changed. Please retry.');
    res.json({ success: true, data });
  }));
  api.delete('/campgrounds/:id', auth, admin, asyncRoute(async (req, res) => {
    const campground = await activeCampground(req.params.id);
    if (await Booking.exists({ campground: campground._id, status: 'active', checkInAt: { $gt: new Date() } })) {
      throw new ApiError(409, 'Campground has upcoming bookings');
    }
    await Campground.updateOne({ _id: campground._id }, { $set: { active: false } });
    res.json({ success: true });
  }));

  api.get('/favorites', auth, asyncRoute(async (req, res) => {
    const user = await User.findById(req.user._id).populate({ path: 'favorites', match: { active: true } });
    res.json({ success: true, count: user.favorites.length, data: user.favorites });
  }));
  api.put('/favorites/:campgroundId', auth, asyncRoute(async (req, res) => {
    const campground = await activeCampground(req.params.campgroundId);
    await User.updateOne({ _id: req.user._id }, { $addToSet: { favorites: campground._id } });
    res.json({ success: true, message: 'Campground added to favorites' });
  }));
  api.delete('/favorites/:campgroundId', auth, asyncRoute(async (req, res) => {
    await User.updateOne({ _id: req.user._id }, { $pull: { favorites: id(req.params.campgroundId) } });
    res.json({ success: true, message: 'Campground removed from favorites' });
  }));

  api.get('/bookings', auth, asyncRoute(async (req, res) => {
    const { skip, limit, page } = pagination(req.query);
    const filter = { ...bookingOwner(req), status: 'active' };
    const [data, total] = await Promise.all([
      Booking.find(filter).populate('campground').sort({ checkIn: 1, _id: 1 }).skip(skip).limit(limit),
      Booking.countDocuments(filter),
    ]);
    res.json({ success: true, count: data.length, total, page, data });
  }));
  api.get('/bookings/:id/notifications', auth, asyncRoute(async (req, res) => {
    const booking = await Booking.findOne({ _id: id(req.params.id), ...bookingOwner(req) }).select('+notifications');
    if (!booking) throw new ApiError(404, 'Booking not found');
    const data = booking.notifications.map(job => ({
      id: job._id, type: job.type, revision: job.revision,
      status: job.type === 'reminder' && (job.revision !== booking.revision || booking.status === 'cancelled')
        && job.status === 'pending' ? 'superseded' : job.status,
      scheduledAt: job.scheduledAt, sentAt: job.sentAt, attempts: job.attempts,
      previewUrl: job.previewUrl, lastError: job.lastError,
    }));
    res.json({ success: true, data });
  }));
  api.get('/bookings/:id', auth, asyncRoute(async (req, res) => {
    const data = await Booking.findOne({ _id: id(req.params.id), ...bookingOwner(req), status: 'active' }).populate('campground');
    if (!data) throw new ApiError(404, 'Booking not found');
    res.json({ success: true, data });
  }));
  api.post('/bookings', auth, asyncRoute(async (req, res) => {
    const campground = await activeCampground(req.body.campground);
    const dates = bookingDates(req.body.checkIn, req.body.checkOut, campground.timezone);
    const input = {
      user: req.user._id, campground: campground._id,
      checkIn: req.body.checkIn, checkOut: req.body.checkOut,
      checkInAt: dates.checkInAt,
      specialRequest: text(req.body.specialRequest ?? '', 'specialRequest', 2000, { required: false }),
    };
    // The booking and its email jobs persist together in one atomic document write.
    const data = await Booking.create({
      ...input, notifications: notifyInput(input, campground, dates, 'confirmation', 1, req.user.email),
    });
    res.status(201).json({ success: true, emailStatus: 'queued', data: publicBooking(data) });
  }));
  api.patch('/bookings/:id', auth, asyncRoute(async (req, res) => {
    const filter = { _id: id(req.params.id), ...bookingOwner(req), status: 'active' };
    const current = await Booking.findOne(filter);
    if (!current) throw new ApiError(404, 'Booking not found');
    if (current.checkInAt <= new Date()) throw new ApiError(409, 'Booking has already started');
    const campground = await activeCampground(req.body.campground ?? String(current.campground));
    const dates = bookingDates(req.body.checkIn ?? current.checkIn, req.body.checkOut ?? current.checkOut, campground.timezone);
    const input = {
      campground: campground._id,
      checkIn: req.body.checkIn ?? current.checkIn,
      checkOut: req.body.checkOut ?? current.checkOut,
      checkInAt: dates.checkInAt,
      specialRequest: text(req.body.specialRequest ?? current.specialRequest, 'specialRequest', 2000, { required: false }),
    };
    const owner = await User.findById(current.user);
    const revision = current.revision + 1;
    const data = await Booking.findOneAndUpdate({ ...filter, revision: current.revision }, {
      $set: { ...input, revision },
      $push: { notifications: { $each: notifyInput(input, campground, dates, 'update', revision, owner.email) } },
    }, { new: true, runValidators: true });
    if (!data) throw new ApiError(409, 'Booking changed. Please reload and retry.');
    res.json({ success: true, emailStatus: 'queued', data: publicBooking(data) });
  }));
  api.delete('/bookings/:id', auth, asyncRoute(async (req, res) => {
    const data = await Booking.findOneAndUpdate({
      _id: id(req.params.id), ...bookingOwner(req), status: 'active',
    }, { $set: { status: 'cancelled' }, $inc: { revision: 1 } }, { new: true });
    if (!data) throw new ApiError(404, 'Booking not found');
    res.json({ success: true, message: 'Booking cancelled' });
  }));

  app.use((_req, _res, next) => next(new ApiError(404, 'Route not found')));
  app.use((error, _req, res, _next) => {
    const status = error.status || (error.code === 11000 ? 409 : error.name === 'ValidationError' ? 400 : 500);
    const message = error.code === 11000 ? 'Email is already registered'
      : status >= 500 ? 'Service temporarily unavailable' : error.message;
    if (status >= 500) console.error('API error:', error.name);
    res.status(status).json({ success: false, message });
  });
  return app;
}
