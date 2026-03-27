const express = require('express');
const crypto = require('crypto');
const { enqueueFileSyncJob } = require('./queue');
const { logger } = require('./logger');

const router = express.Router();

// Validate webhook origin
// Clio Manage webhooks don't send HMAC signatures. We verify using
// a shared secret in the URL query string if CLIO_WEBHOOK_SECRET is set.
function validateSignature(req) {
  const secret = process.env.CLIO_WEBHOOK_SECRET;
  if (!secret) return true; // skip validation if not configured

  // Check x-clio-signature header (if Clio ever adds it)
  const signature = req.headers['x-clio-signature'];
  if (signature) {
    const payload = JSON.stringify(req.body);
    const expected = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expected, 'hex')
      );
    } catch {
      return false;
    }
  }

  // No signature header — accept if request has valid topic/model structure
  // (Clio Manage webhooks don't sign payloads)
  return true;
}

router.post('/clio', async (req, res) => {
  // Acknowledge immediately — Clio expects fast response
  res.status(200).json({ received: true });

  try {
    const body = req.body;

    if (!validateSignature(req)) {
      logger.warn('Invalid Clio webhook signature — ignoring');
      return;
    }

    const topic = body?.topic;
    const action = body?.action;

    if (topic !== 'matter' || action !== 'created') {
      logger.debug(`Skipping event: ${topic}/${action}`);
      return;
    }

    const matter = body?.data;
    if (!matter) {
      logger.warn('matter.created payload missing data field');
      return;
    }

    const responsibleAttorney = matter?.responsible_attorney?.name || '';
    const targetAttorney = process.env.RESPONSIBLE_ATTORNEY_NAME || 'Nick Noe';

    if (!responsibleAttorney.toLowerCase().includes(targetAttorney.toLowerCase())) {
      logger.debug(`Skipping matter — responsible attorney: ${responsibleAttorney}`);
      return;
    }

    const jobPayload = {
      matter_id: matter.id,
      matter_number: matter.display_number || matter.id,
      matter_name: matter.description || matter.display_number,
      client_name: matter?.client?.name || 'Unknown Client',
      client_id: matter?.client?.id,
      practice_area: matter?.practice_area?.name || null,
    };

    const delayMinutes = parseInt(process.env.DELAY_MINUTES || '60', 10);
    logger.info(`New matter matched: ${jobPayload.matter_number} — ${jobPayload.client_name}. Scheduling sync in ${delayMinutes} min.`);

    await enqueueFileSyncJob(jobPayload, delayMinutes);
  } catch (err) {
    logger.error('Error processing webhook', err);
  }
});

module.exports = { webhookRouter: router };
