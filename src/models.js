import mongoose from 'mongoose';

const { Schema } = mongoose;
const userSchema = new Schema({
  name: { type: String, required: true, maxlength: 100 },
  phone: { type: String, required: true, maxlength: 30 },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true, select: false },
  role: { type: String, enum: ['user', 'admin'], default: 'user', immutable: true },
  favorites: [{ type: Schema.Types.ObjectId, ref: 'Campground' }],
}, { timestamps: true });
userSchema.set('toJSON', { transform: (_doc, result) => {
  delete result.password;
  delete result.__v;
  return result;
} });

const sessionSchema = new Schema({
  _id: String,
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
});

const campgroundSchema = new Schema({
  name: { type: String, required: true, maxlength: 150 },
  address: { type: String, required: true, maxlength: 500 },
  phone: { type: String, required: true, maxlength: 30 },
  latitude: { type: Number, required: true, min: -90, max: 90 },
  longitude: { type: Number, required: true, min: -180, max: 180 },
  timezone: { type: String, default: 'Asia/Bangkok' },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const notificationSchema = new Schema({
  type: { type: String, enum: ['confirmation', 'update', 'reminder'], required: true },
  revision: { type: Number, required: true },
  recipient: { type: String, required: true },
  snapshot: { type: Schema.Types.Mixed, required: true },
  scheduledAt: { type: Date, required: true },
  nextAttemptAt: { type: Date, required: true },
  status: {
    type: String,
    enum: ['pending', 'processing', 'sent', 'preview', 'failed', 'superseded'],
    default: 'pending',
  },
  attempts: { type: Number, default: 0 },
  claimToken: String,
  leaseUntil: Date,
  sentAt: Date,
  messageId: String,
  previewUrl: String,
  lastError: String,
});

const bookingSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  campground: { type: Schema.Types.ObjectId, ref: 'Campground', required: true },
  checkIn: { type: String, required: true },
  checkOut: { type: String, required: true },
  checkInAt: { type: Date, required: true },
  specialRequest: { type: String, default: '', maxlength: 2000 },
  revision: { type: Number, default: 1 },
  status: { type: String, enum: ['active', 'cancelled'], default: 'active' },
  notifications: { type: [notificationSchema], default: [], select: false },
}, { timestamps: true });
bookingSchema.index({ user: 1, status: 1 });
bookingSchema.index({ status: 1, 'notifications.nextAttemptAt': 1 });

export const User = mongoose.model('User', userSchema);
export const Session = mongoose.model('Session', sessionSchema);
export const Campground = mongoose.model('Campground', campgroundSchema);
export const Booking = mongoose.model('Booking', bookingSchema);
