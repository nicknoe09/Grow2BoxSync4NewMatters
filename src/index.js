require('dotenv').config();
const express = require('express');
const { setupQueue } = require('./queue');
const { webhookRouter } = require('./webhook');
const { logger } = require('./logger');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Health check
app.get('/health', async (req, res) => {
  const { getQueueStats } = require('./queue');
  const stats = await getQueueStats();
  res.json({ status: 'ok', queue: stats });
});

// Clio webhook endpoint
app.use('/webhooks', webhookRouter);

async function start() {
  await setupQueue();
  app.listen(PORT, () => {
    logger.info(`Clio→Box sync service running on port ${PORT}`);
  });
}

start().catch((err) => {
  logger.error('Failed to start service', err);
  process.exit(1);
});
