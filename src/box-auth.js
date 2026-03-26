const axios = require('axios');
const IORedis = require('ioredis');
const { logger } = require('./logger');

// In-memory token cache
let cachedToken = null;
let tokenExpiresAt = 0;

const REDIS_KEY = 'box:refresh_token';

function getRedis() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  return new IORedis(url, { maxRetriesPerRequest: 3 });
}

async function getStoredRefreshToken() {
  try {
    const redis = getRedis();
    const stored = await redis.get(REDIS_KEY);
    await redis.quit();
    if (stored) {
      logger.debug('Loaded Box refresh token from Redis');
      return stored;
    }
  } catch (err) {
    logger.warn('Could not read refresh token from Redis, falling back to env var', err);
  }
  return process.env.BOX_REFRESH_TOKEN;
}

async function storeRefreshToken(token) {
  try {
    const redis = getRedis();
    await redis.set(REDIS_KEY, token);
    await redis.quit();
    logger.debug('Stored Box refresh token in Redis');
  } catch (err) {
    logger.warn('Could not persist refresh token to Redis', err);
  }
}

async function getBoxToken() {
  const now = Date.now();

  // Return cached token if still valid (with 5-min buffer)
  if (cachedToken && now < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  // Refresh using refresh token
  const refreshToken = await getStoredRefreshToken();
  const clientId = process.env.BOX_CLIENT_ID;
  const clientSecret = process.env.BOX_CLIENT_SECRET;

  if (!refreshToken || !clientId || !clientSecret) {
    // Fall back to static access token if no OAuth credentials
    const staticToken = process.env.BOX_ACCESS_TOKEN;
    if (staticToken) {
      logger.warn('Using static BOX_ACCESS_TOKEN — will expire in ~60min');
      return staticToken;
    }
    throw new Error('No Box credentials configured. Set BOX_REFRESH_TOKEN + BOX_CLIENT_ID + BOX_CLIENT_SECRET, or BOX_ACCESS_TOKEN.');
  }

  logger.info('Refreshing Box access token...');
  const resp = await axios.post(
    'https://api.box.com/oauth2/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  cachedToken = resp.data.access_token;
  tokenExpiresAt = now + resp.data.expires_in * 1000;

  // Persist the rotated refresh token to Redis (survives container restarts)
  const newRefreshToken = resp.data.refresh_token;
  process.env.BOX_REFRESH_TOKEN = newRefreshToken;
  await storeRefreshToken(newRefreshToken);

  logger.info(`Box token refreshed. Expires in ${resp.data.expires_in}s`);
  return cachedToken;
}

module.exports = { getBoxToken };
