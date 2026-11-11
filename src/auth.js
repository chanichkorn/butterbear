import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { User, Session } from './models.js';
import { ApiError } from './validation.js';

export async function issueSession(user) {
  const sessionId = crypto.randomUUID();
  const token = jwt.sign({}, process.env.JWT_SECRET, {
    subject: String(user._id),
    jwtid: sessionId,
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
    algorithm: 'HS256',
  });
  const decoded = jwt.decode(token);
  await Session.create({ _id: sessionId, user: user._id, expiresAt: new Date(decoded.exp * 1000) });
  return token;
}

export async function authenticate(req, _res, next) {
  try {
    const header = req.get('Authorization') || '';
    if (!header.startsWith('Bearer ')) throw new ApiError(401, 'Authentication required');
    let decoded;
    try {
      decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      throw new ApiError(401, 'Invalid or expired token');
    }
    const session = await Session.findOne({ _id: decoded.jti, user: decoded.sub, expiresAt: { $gt: new Date() } });
    if (!session) throw new ApiError(401, 'Session expired or logged out');
    const user = await User.findById(decoded.sub);
    if (!user) throw new ApiError(401, 'User no longer exists');
    req.user = user;
    req.sessionId = session._id;
    next();
  } catch (error) {
    next(error);
  }
}

export function admin(req, _res, next) {
  if (req.user.role !== 'admin') return next(new ApiError(403, 'Admin access required'));
  next();
}

export function bookingOwner(req) {
  return req.user.role === 'admin' ? {} : { user: req.user._id };
}
