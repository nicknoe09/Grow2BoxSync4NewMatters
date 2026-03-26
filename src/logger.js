const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const levels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = levels[LOG_LEVEL] ?? 1;

function log(level, message, extra) {
  if (levels[level] < currentLevel) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${message}`;
  if (extra instanceof Error) {
    console[level === 'error' ? 'error' : 'log'](line, extra.stack || extra.message);
  } else if (extra) {
    console[level === 'error' ? 'error' : 'log'](line, extra);
  } else {
    console[level === 'error' ? 'error' : 'log'](line);
  }
}

const logger = {
  debug: (msg, extra) => log('debug', msg, extra),
  info:  (msg, extra) => log('info',  msg, extra),
  warn:  (msg, extra) => log('warn',  msg, extra),
  error: (msg, extra) => log('error', msg, extra),
};

module.exports = { logger };
