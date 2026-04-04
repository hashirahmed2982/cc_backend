const mysql = require('mysql2/promise');
const fs    = require('fs');
const path  = require('path');
require('dotenv').config();

async function runMigration() {
  console.log('🚀 Starting database migration...\n');

  const connection = await mysql.createConnection({
    host:               process.env.DB_HOST     || 'localhost',
    port:               process.env.DB_PORT     || 3306,
    user:               process.env.DB_USER     || 'root',
    password:           process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  try {
    console.log('✓ Connected to MySQL server');

    const migrationFile = '000_full_schema.sql';
    const migrationPath = path.join(__dirname, migrationFile);

    if (!fs.existsSync(migrationPath)) {
      throw new Error(`Migration file not found: ${migrationPath}`);
    }

    const sql = fs.readFileSync(migrationPath, 'utf8');
    console.log(`✓ Loaded: ${migrationFile}`);
    console.log('⏳ Executing migration...\n');

    await connection.query(sql);

    console.log('✅ Migration completed successfully!\n');
    console.log('📊 Schema summary:');
    console.log('   Tables:  19  (roles, users, viewer_accounts, sessions,');
    console.log('                  wallets, topup_requests, wallet_transactions,');
    console.log('                  products, product_skus, inventory, digital_codes,');
    console.log('                  orders, order_details, client_pricing,');
    console.log('                  client_product_access, supplier_config,');
    console.log('                  audit_logs, api_logs, support_tickets)');
    console.log('   Roles:   4   (super_admin, admin, b2b_client, viewer)');
    console.log('   Seed:    1   super admin user created');
    console.log('\n👤 Super Admin Credentials:');
    console.log('   Email:    admin@cardcove.com');
    console.log('   Password: Admin@123');
    console.log('\n🎉 Start the server with: npm run dev');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    if (error.sqlMessage) console.error('   SQL error:', error.sqlMessage);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();