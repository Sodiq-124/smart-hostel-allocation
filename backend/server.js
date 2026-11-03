




require('dotenv').config();

const { validateSessionSecret } = require('./config/security');

try {
  validateSessionSecret(process.env);
} catch (error) {
  console.error(`\n  Startup refused: ${error.message}\n`);
  process.exit(1);
}

const app = require('./app');
const { pool, testConnection } = require('./config/database');

const PORT = Number(process.env.PORT) || 5000;

async function start() {
  
  
  
  
  try {
    await testConnection();
    console.log(`  Database   : connected to "${process.env.DB_NAME}"`);
  } catch (error) {
    console.warn('  Database   : NOT CONNECTED');
    console.warn(`               reason: ${error.code || error.message}`);
    console.warn('               The server will still start, but any route that');
    console.warn('               touches the database will return 503.');
    console.warn('               Fix: check MySQL is running and that DB_USER,');
    console.warn('               DB_PASSWORD and DB_NAME in backend/.env are correct.');
  }

  const server = app.listen(PORT, () => {
    console.log('');
    console.log('  LASU Smart Hostel Allocation System');
    console.log('  ----------------------------------------------');
    console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`  Web app    : http://localhost:${PORT}`);
    console.log(`  API health : http://localhost:${PORT}/api/health`);
    console.log('  ----------------------------------------------');
    console.log('');
  });

  
  async function shutdown(signal) {
    console.log(`\n  ${signal} received. Shutting down...`);
    server.close(async () => {
      await pool.end();
      console.log('  Server and database pool closed.');
      process.exit(0);
    });

    
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  
  
  process.on('unhandledRejection', (reason) => {
    console.error('  UNHANDLED PROMISE REJECTION:', reason);
  });
  process.on('uncaughtException', (error) => {
    console.error('  UNCAUGHT EXCEPTION:', error);
    process.exit(1);
  });
}

start();
