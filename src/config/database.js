const mysql = require('mysql2/promise');
const logger = require('../utils/logger');

// Create connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'cardcove_db',
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 20,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  timezone: '+00:00', // Store dates as UTC
  dateStrings: false,
  multipleStatements: false // Security: prevent SQL injection via multiple statements
});

// Test connection
pool.getConnection()
  .then(connection => {
    logger.info('Database connection pool created successfully');
    connection.release();
  })
  .catch(err => {
    logger.error('Failed to create database connection pool:', err);
  });

// Helper function to execute queries with error handling
const query = async (sql, params) => {
  try {
    const [results] = await pool.query(sql, params);
    return results;
  } catch (error) {
    logger.error('Database query error:', {
      sql: sql.substring(0, 100),
      error: error.message
    });
    throw error;
  }
};

// Helper function for transactions
const transaction = async (callback) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    logger.error('Transaction error:', error);
    throw error;
  } finally {
    connection.release();
  }
};

// Helper function to get single row
const queryOne = async (sql, params) => {
  const results = await query(sql, params);
  return results[0] || null;
};

// Helper function for batch inserts
const batchInsert = async (table, columns, values) => {
  if (!values || values.length === 0) {
    return { affectedRows: 0 };
  }

  const placeholders = values.map(() => 
    `(${columns.map(() => '?').join(', ')})`
  ).join(', ');

  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}`;
  const flatValues = values.flat();

  return await query(sql, flatValues);
};

module.exports = {
  pool,
  query,
  queryOne,
  transaction,
  batchInsert,
  getConnection: () => pool.getConnection(),
  end: () => pool.end()
};