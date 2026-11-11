import 'dotenv/config';

export function validateConfig(env = process.env) {
  if (!env.MONGO_URI) throw new Error('MONGO_URI is required');
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32 || env.JWT_SECRET.startsWith('replace-')) {
    throw new Error('JWT_SECRET must contain at least 32 random characters');
  }
  const mailMode = env.MAIL_TRANSPORT || 'ethereal';
  if (!['smtp', 'ethereal'].includes(mailMode)) throw new Error('Invalid MAIL_TRANSPORT');
  if (env.NODE_ENV === 'production' && mailMode !== 'smtp') {
    throw new Error('Production requires MAIL_TRANSPORT=smtp');
  }
  if (mailMode === 'smtp' && (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD)) {
    throw new Error('SMTP_HOST, SMTP_USER and SMTP_PASSWORD are required');
  }
}
