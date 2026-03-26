const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const { runFileSync } = require('./sync');
const { logger } = require('./logger');

const QUEUE_NAME = 'clio-box-sync';
let queue;
let worker;

function getRedisConnection() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  return new IORedis(url, {
    maxRetriesPerRequest: null, // required by BullMQ
  });
}

async function setupQueue() {
  const connection = getRedisConnection();

  queue = new Queue(QUEUE_NAME, { connection });

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      logger.info(`Processing job ${job.id} for matter ${job.data.matter_number}`);
      await runFileSync(job.data);
    },
    {
      connection: getRedisConnection(),
      concurrency: 2,
    }
  );

  worker.on('completed', (job) => {
    logger.info(`Job ${job.id} completed for matter ${job.data.matter_number}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Job ${job?.id} failed for matter ${job?.data?.matter_number}: ${err.message}`);
  });

  logger.info('Queue and worker initialized');
}

async function enqueueFileSyncJob(payload, delayMinutes) {
  const delayMs = delayMinutes * 60 * 1000;
  const job = await queue.add('sync-matter-files', payload, {
    delay: delayMs,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
  logger.info(`Job ${job.id} enqueued with ${delayMinutes}min delay`);
  return job;
}

async function getQueueStats() {
  if (!queue) return { error: 'queue not initialized' };
  const [waiting, delayed, active, completed, failed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getDelayedCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
  ]);
  return { waiting, delayed, active, completed, failed };
}

module.exports = { setupQueue, enqueueFileSyncJob, getQueueStats };
