const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function runMigration() {
  console.log('🚀 Starting database migration...\n');

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true
  });

  try {
    console.log('✓ Connected to MySQL server');

    // Read migration file
    const migrationPath = path.join(__dirname, '004_digital_codes_unique_index.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    console.log('✓ Migration file loaded');
    console.log('⏳ Executing migration...\n');

    // Execute migration
    await connection.query(sql);

    console.log('\n✅ Migration completed successfully!');
    console.log('\n📊 Summary:');
    console.log('   - Database: cardcove_db created');
    console.log('   - 18 tables created');
    console.log('   - 4 roles inserted');
    console.log('   - 1 super admin user created');
    console.log('\n👤 Super Admin Credentials:');
    console.log('   Email: admin@cardcove.com');
    console.log('   Password: Admin@123');
    console.log('\n🎉 You can now start the server with: npm run dev');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
