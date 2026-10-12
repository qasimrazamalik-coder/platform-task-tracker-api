const config = require('./config');
const { createApp } = require('./app');
const { pool } = require('./db');

const server = createApp().listen(config.port, () => {
  console.log(`Platform running at http://localhost:${config.port}  (API docs: /api/docs)`);
});

function shutdown() {
  server.close(() => pool.end().then(() => process.exit(0)));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
