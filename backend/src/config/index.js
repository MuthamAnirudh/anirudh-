const crypto = require('crypto');

const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const isDevelopment = !isProduction;

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function validateSecret(name, minLength = 32) {
  const value = required(name);
  if (value.length < minLength) throw new Error(`${name} must be at least ${minLength} characters in production.`);
  return value;
}

function validateProductionConfig() {
  if (!isProduction) return;
  required('DATABASE_URL');
  validateSecret('JWT_ACCESS_SECRET');
  validateSecret('JWT_REFRESH_SECRET');
  if (process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET) {
    throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different in production.');
  }
  const cors = String(process.env.CORS_ORIGIN || '').trim();
  if (!cors || cors === '*') throw new Error('CORS_ORIGIN must explicitly list allowed frontend origins in production.');
  const origins = cors.split(',').map(s => s.trim()).filter(Boolean);
  if (origins.some(origin => !/^https:\/\//i.test(origin))) {
    throw new Error('Every production CORS_ORIGIN must use HTTPS origins.');
  }
  validateSecret('AI_ML_SERVICE_TOKEN');
  validateSecret('OPERATIONS_TOKEN');
  // Password recovery e-mail may be configured either through environment variables OR by the
  // Admin from the portal Settings screen (stored in the database), so a missing env var must not
  // stop the server from booting. A warning is logged and /api/portal-auth/recovery/status
  // reports what is missing.
  const have = (...n) => n.some(k => String(process.env[k] || '').trim());
  const missing = [];
  if (!have('RECOVERY_EMAILJS_SERVICE_ID', 'EMAILJS_SERVICE_ID')) missing.push('service id');
  if (!have('RECOVERY_EMAILJS_TEMPLATE_ID', 'EMAILJS_TEMPLATE_ID')) missing.push('template id');
  if (!have('RECOVERY_EMAILJS_PUBLIC_KEY', 'EMAILJS_PUBLIC_KEY')) missing.push('public key');
  if (!have('RECOVERY_EMAILJS_PRIVATE_KEY', 'EMAILJS_PRIVATE_KEY')) missing.push('private key');
  if (missing.length) console.warn('[config] Recovery e-mail env vars missing (' + missing.join(', ') + '). Set them in Vercel or save them from Admin -> Settings.');
}

function bootConfig() {
  validateProductionConfig();
  const generatedDevAccess = crypto.randomBytes(32).toString('hex');
  const generatedDevRefresh = crypto.randomBytes(32).toString('hex');
  return {
    isProduction,
    isDevelopment,
    accessSecret: isProduction ? required('JWT_ACCESS_SECRET') : (process.env.JWT_ACCESS_SECRET || generatedDevAccess),
    refreshSecret: isProduction ? required('JWT_REFRESH_SECRET') : (process.env.JWT_REFRESH_SECRET || generatedDevRefresh),
  };
}

module.exports = bootConfig();
