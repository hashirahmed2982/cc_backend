require('dotenv').config();
const app = require('./src/app');
const logger = require('./src/utils/logger');
const db = require('./src/config/database');

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0'; // Explicitly bind to all interfaces

// Test database connection
db.getConnection()
  .then((connection) => {
    logger.info('✓ Database connected successfully');
    connection.release();
    
    // Start server
    const server = app.listen(PORT, HOST, () => {
      logger.info(`✓ Server running on http://${HOST}:${PORT}`);
      logger.info(`✓ Environment: ${process.env.NODE_ENV}`);
      logger.info(`✓ API Version: ${process.env.API_VERSION}`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('SIGTERM signal received: closing HTTP server');
      server.close(() => {
        logger.info('HTTP server closed');
        db.end(() => {
          logger.info('Database pool closed');
          process.exit(0);
        });
      });
    });

    process.on('SIGINT', () => {
      logger.info('SIGINT signal received: closing HTTP server');
      server.close(() => {
        logger.info('HTTP server closed');
        db.end(() => {
          logger.info('Database pool closed');
          process.exit(0);
        });
      });
    });
  })
  .catch((error) => {
    logger.error('✗ Unable to connect to database:', error);
    process.exit(1);
  });

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
