import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { Campground, User } from '../src/models.js';
import { email, password, text } from '../src/validation.js';

if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
await mongoose.connect(process.env.MONGO_URI);
try {
  await Promise.all([Campground.init(), User.init()]);
  const camps = [
    { name: 'Butterbear Khao Yai', address: 'Pak Chong, Nakhon Ratchasima', phone: '0800000001', latitude: 14.439, longitude: 101.372, timezone: 'Asia/Bangkok' },
    { name: 'Butterbear Chiang Mai', address: 'Mae Rim, Chiang Mai', phone: '0800000002', latitude: 18.915, longitude: 98.943, timezone: 'Asia/Bangkok' },
  ];
  for (const campground of camps) {
    await Campground.updateOne({ name: campground.name }, { $setOnInsert: campground }, { upsert: true });
  }
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const address = email(process.env.ADMIN_EMAIL);
    const existing = await User.findOne({ email: address });
    if (existing && existing.role !== 'admin') {
      throw new Error('ADMIN_EMAIL belongs to a normal user. Choose a different address.');
    }
    if (!existing) {
      await User.create({
        name: text(process.env.ADMIN_NAME || 'Butterbear Admin', 'name', 100),
        phone: text(process.env.ADMIN_PHONE || '0800000000', 'phone', 30),
        email: address, password: await bcrypt.hash(password(process.env.ADMIN_PASSWORD), 12), role: 'admin',
      });
    }
    console.log('Admin account is ready.');
  } else {
    console.log('Set ADMIN_EMAIL and ADMIN_PASSWORD to seed an admin account.');
  }
  console.log('Sample campgrounds are ready.');
} finally {
  await mongoose.disconnect();
}
