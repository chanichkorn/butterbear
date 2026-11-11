import mongoose from 'mongoose';
import { validateConfig } from './config.js';
import { createApp } from './app.js';
import { createMailer } from './services/mail.js';
import { startNotificationWorker } from './services/notifications.js';

validateConfig();
await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
await Promise.all(Object.values(mongoose.models).map(model => model.init()));
// Set up a test SMTP inbox by default. Production requires real SMTP settings.
const mailer = await createMailer();
const stopWorker = startNotificationWorker(mailer);
const server = createApp().listen(Number(process.env.PORT || 5005), '0.0.0.0', () => {
  console.log(`Butterbear API listening on port ${process.env.PORT || 5005}`);
  console.log(`Email transport: ${mailer.preview ? 'Ethereal test inbox (preview only)' : 'SMTP'}`);
});
async function shutdown() {
  server.close(async () => {
    await stopWorker();
    mailer.transport.close();
    await mongoose.disconnect();
    process.exit(0);
  });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
