import nodemailer from 'nodemailer';

export async function createMailer() {
  const mode = process.env.MAIL_TRANSPORT || 'ethereal';
  if (mode === 'ethereal') {
    const account = await nodemailer.createTestAccount();
    const transport = nodemailer.createTransport({
      host: account.smtp.host, port: account.smtp.port, secure: account.smtp.secure,
      auth: { user: account.user, pass: account.pass },
      connectionTimeout: 10000, socketTimeout: 15000,
    });
    return { transport, preview: true };
  }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    connectionTimeout: 10000, socketTimeout: 15000,
  });
  await transport.verify();
  return { transport, preview: false };
}

export function notificationJobs({ type, revision, recipient, campground, checkIn, checkOut,
  specialRequest, reminderAt, now = new Date() }) {
  const snapshot = {
    name: campground.name,
    address: campground.address,
    latitude: campground.latitude,
    longitude: campground.longitude,
    timezone: campground.timezone,
    checkIn, checkOut, specialRequest,
  };
  return [
    { type, revision, recipient, snapshot, scheduledAt: now, nextAttemptAt: now },
    { type: 'reminder', revision, recipient, snapshot, scheduledAt: reminderAt, nextAttemptAt: reminderAt },
  ];
}

export function composeEmail(booking, job, forecast) {
  const labels = {
    confirmation: 'Booking confirmed',
    update: 'Booking updated',
    reminder: 'Your upcoming campground booking',
  };
  const s = job.snapshot;
  const lines = [
    labels[job.type], '', `Booking ID: ${booking._id}`,
    `Campground: ${s.name}`, `Address: ${s.address}`,
    `Check-in: ${s.checkIn} at 14:00 (${s.timezone})`,
    `Check-out: ${s.checkOut}`,
    `Special request: ${s.specialRequest || 'None'}`,
  ];
  if (job.type === 'reminder') {
    lines.push('', forecast
      ? `Check-in forecast: ${forecast.minTemperature} to ${forecast.maxTemperature} °C. Rain probability: ${forecast.precipitationProbability}%. Weather code: ${forecast.weatherCode}. Source: Open-Meteo (https://open-meteo.com/).`
      : 'The weather forecast is temporarily unavailable. Your booking remains confirmed.');
  }
  return {
    from: process.env.MAIL_FROM || 'Butterbear <bookings@butterbear.example>',
    to: job.recipient,
    subject: `Butterbear - ${labels[job.type]}`,
    text: lines.join('\n'),
    messageId: `<${booking._id}-${job._id}@butterbear.local>`,
  };
}

export function previewUrl(info) {
  return nodemailer.getTestMessageUrl(info) || undefined;
}
