const axios = require('axios');
const { logger } = require('./logger');

const CLIO_API_BASE = 'https://app.clio.com/api/v4';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://athletic-gratitude-production.up.railway.app/webhooks/clio';

let webhookId = null;

function getClioHeaders() {
  const token = process.env.CLIO_ACCESS_TOKEN;
  if (!token) throw new Error('CLIO_ACCESS_TOKEN not set');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function findExistingWebhook() {
  const resp = await axios.get(`${CLIO_API_BASE}/webhooks.json`, {
    headers: getClioHeaders(),
    params: { fields: 'id,url,model,events,status,expires_at', limit: 50 },
  });

  const webhooks = resp.data?.data || [];
  return webhooks.find(
    (w) => w.url === WEBHOOK_URL && w.model === 'matter' && w.events?.includes('created')
  );
}

async function createWebhook() {
  const resp = await axios.post(`${CLIO_API_BASE}/webhooks.json`, {
    data: {
      url: WEBHOOK_URL,
      events: ['created'],
      model: 'matter',
      fields: ['id', 'display_number', 'description', 'status', 'client', 'responsible_attorney', 'practice_area'],
    },
  }, { headers: getClioHeaders() });

  return resp.data?.data;
}

async function deleteWebhook(id) {
  await axios.delete(`${CLIO_API_BASE}/webhooks/${id}.json`, {
    headers: getClioHeaders(),
  });
}

async function ensureWebhook() {
  try {
    const existing = await findExistingWebhook();

    if (existing) {
      const expiresAt = new Date(existing.expires_at);
      const hoursUntilExpiry = (expiresAt - Date.now()) / (1000 * 60 * 60);

      if (hoursUntilExpiry > 12) {
        webhookId = existing.id;
        logger.info(`Clio webhook OK (id=${existing.id}, expires in ${Math.round(hoursUntilExpiry)}h)`);
        return;
      }

      // Expiring soon — delete and recreate
      logger.info(`Clio webhook expiring in ${Math.round(hoursUntilExpiry)}h — renewing`);
      await deleteWebhook(existing.id);
    }

    const created = await createWebhook();
    webhookId = created.id;
    logger.info(`Clio webhook registered (id=${created.id})`);
  } catch (err) {
    logger.error(`Failed to ensure Clio webhook: ${err.message}`);
  }
}

// Renew every 12 hours
let renewalInterval = null;

function startWebhookRenewal() {
  ensureWebhook();
  renewalInterval = setInterval(ensureWebhook, 12 * 60 * 60 * 1000);
  logger.info('Clio webhook auto-renewal started (every 12h)');
}

function stopWebhookRenewal() {
  if (renewalInterval) {
    clearInterval(renewalInterval);
    renewalInterval = null;
  }
}

module.exports = { startWebhookRenewal, stopWebhookRenewal, ensureWebhook };
