import crypto from 'node:crypto';
import { Booking } from '../models.js';
import { composeEmail, previewUrl } from './mail.js';
import { getWeather } from './weather.js';

const MAX_ATTEMPTS = 5;
const LEASE_MS = 60000;

// Delivery is at least once. The stable Message-ID helps identify a retry after a crash.
export async function deliverNext(mailer, { now = new Date(), weather = getWeather } = {}) {
  await Booking.updateMany({
    'notifications.status': 'processing',
  }, {
    $set: { 'notifications.$[job].status': 'pending' },
  }, {
    arrayFilters: [{ 'job.status': 'processing', 'job.leaseUntil': { $lte: now } }],
  });
  const claimToken = crypto.randomUUID();
  const booking = await Booking.findOneAndUpdate({
    status: 'active',
    notifications: { $elemMatch: {
      status: 'pending', scheduledAt: { $lte: now }, nextAttemptAt: { $lte: now },
    } },
  }, {
    $set: {
      'notifications.$.status': 'processing',
      'notifications.$.claimToken': claimToken,
      'notifications.$.leaseUntil': new Date(now.getTime() + LEASE_MS),
    },
    $inc: { 'notifications.$.attempts': 1 },
  }, { new: true }).select('+notifications');
  if (!booking) return false;
  const job = booking.notifications.find(item => item.claimToken === claimToken);
  const match = { _id: booking._id, notifications: { $elemMatch: {
    _id: job._id, claimToken, status: 'processing',
  } } };
  if (job.type === 'reminder'
    && (job.revision !== booking.revision || booking.checkInAt <= now)) {
    await Booking.updateOne(match, { $set: { 'notifications.$.status': 'superseded' } });
    return true;
  }
  try {
    let forecast;
    if (job.type === 'reminder') {
      try {
        forecast = await weather(job.snapshot, job.snapshot.checkIn, { now });
      } catch {
        // A weather outage must not prevent the booking reminder.
        forecast = null;
      }
    }
    // Recheck after the external weather request in case the booking changed.
    const current = await Booking.findById(booking._id).select('status revision checkInAt');
    if (!current || current.status !== 'active'
      || (job.type === 'reminder' && (current.revision !== job.revision || current.checkInAt <= now))) {
      await Booking.updateOne(match, { $set: { 'notifications.$.status': 'superseded' } });
      return true;
    }
    const info = await mailer.transport.sendMail(composeEmail(booking, job, forecast));
    if (info.rejected?.length || (info.accepted && info.accepted.length === 0)) {
      throw new Error('SMTP rejected the recipient');
    }
    await Booking.updateOne(match, { $set: {
      'notifications.$.status': mailer.preview ? 'preview' : 'sent',
      'notifications.$.sentAt': now,
      'notifications.$.messageId': info.messageId,
      'notifications.$.previewUrl': mailer.preview ? previewUrl(info) : undefined,
      'notifications.$.lastError': '',
    } });
  } catch {
    await Booking.updateOne(match, { $set: {
      'notifications.$.status': job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
      'notifications.$.nextAttemptAt': new Date(now.getTime() + 60000 * 2 ** (job.attempts - 1)),
      'notifications.$.lastError': 'Email delivery failed. Check SMTP configuration or retry later.',
    } });
  }
  return true;
}

export function startNotificationWorker(mailer) {
  let running = false;
  let stopped = false;
  let idle;
  const tick = () => {
    if (running || stopped) return;
    running = true;
    idle = (async () => {
      try {
        for (let count = 0; count < 20 && !stopped; count++) {
          if (!await deliverNext(mailer)) break;
        }
      } catch (error) {
        console.error('Notification worker error:', error.name);
      } finally {
        running = false;
      }
    })();
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await idle;
  };
}
