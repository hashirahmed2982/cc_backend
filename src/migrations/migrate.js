const mysql = require('mysql2/promise');
const fs    = require('fs');
const path  = require('path');
require('dotenv').config();

async function runMigration() {
  console.log('🚀 Starting database migration...\n');

  // NOTE: deliberately NOT passing `database` here — 000_full_schema.sql
  // does its own CREATE DATABASE IF NOT EXISTS + USE, which requires
  // connecting WITHOUT a database selected (the DB may not exist yet on a
  // fresh install). Every incremental migration (007+) assumes the
  // database already exists and has no USE of its own, so those need an
  // explicit USE issued below instead — see the migrationFile check.
  const connection = await mysql.createConnection({
    host:               process.env.DB_HOST     || 'localhost',
    port:               process.env.DB_PORT     || 3306,
    user:               process.env.DB_USER     || 'root',
    password:           process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  try {
    console.log('✓ Connected to MySQL server');

    // Defaults to the fresh-install baseline (000_full_schema.sql). Pass a
    // filename to run an incremental migration instead, e.g. against a DB
    // that already ran 000 before this file existed:
    //   node src/migrations/migrate.js 007_wgcards_integration.sql
    const migrationFile = process.argv[2] || '000_full_schema.sql';
    const migrationPath = path.join(__dirname, migrationFile);

    if (!fs.existsSync(migrationPath)) {
      throw new Error(`Migration file not found: ${migrationPath}`);
    }

    const sql = fs.readFileSync(migrationPath, 'utf8');
    console.log(`✓ Loaded: ${migrationFile}`);

    // 000_full_schema.sql selects its own database (CREATE DATABASE IF NOT
    // EXISTS + USE) — every incremental migration assumes the database
    // already exists and needs this instead, or every statement fails with
    // "No database selected".
    if (migrationFile !== '000_full_schema.sql') {
      const dbName = process.env.DB_NAME || 'cardcove_db';
      await connection.query(`USE \`${dbName}\``);
      console.log(`✓ Using database: ${dbName}`);
    }

    console.log('⏳ Executing migration...\n');

    await connection.query(sql);

    console.log('✅ Migration completed successfully!\n');
    if (migrationFile === '000_full_schema.sql') {
      console.log('📊 Schema summary:');
      console.log('   Tables:  21  (roles, users, viewer_accounts, sessions,');
      console.log('                  wallets, topup_requests, wallet_transactions,');
      console.log('                  products, product_skus, inventory, digital_codes,');
      console.log('                  orders, order_details, client_pricing,');
      console.log('                  client_product_access, supplier_config,');
      console.log('                  audit_logs, api_logs, support_tickets,');
      console.log('                  wgcards_topup_orders, system_settings)');
      console.log('   Roles:   4   (super_admin, admin, b2b_client, viewer)');
      console.log('   Seed:    1   super admin user created');
      console.log('\n👤 Super Admin Credentials:');
      console.log('   Email:    admin@cardcove.com');
      console.log('   Password: Admin@123');
      console.log('\n🎉 Start the server with: npm run dev');
    }

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    if (error.sqlMessage) console.error('   SQL error:', error.sqlMessage);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();