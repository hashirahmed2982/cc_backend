-- ============================================
-- SEED: Super Admin Users
-- Password for all three: CardCove@123
-- ============================================

-- Insert roles (safe — skips if already exist)
INSERT IGNORE INTO roles (role_name, description, permissions) VALUES
('super_admin', 'Super Administrator with full access',   '{"all": true}'),
('admin',       'Administrator with admin portal access', '{"user_management": true, "product_management": true, "wallet_management": true, "reports": true}'),
('b2b_client',  'B2B Client with client portal access',  '{"view_products": true, "place_orders": true, "view_wallet": true}'),
('viewer',      'Viewer account with limited access',     '{"view_products": true, "view_orders": true}');

-- ─── Super Admin 1: Musab Abu Baker ──────────────────────────────────────────
INSERT IGNORE INTO users (
    email, password_hash, full_name,
    role_id, user_type, status, email_verified,
    must_change_password
) VALUES (
    'musab.abubaker@cardcovefzc.com',
    '$2b$12$F.0eIzoebt4WrAsZQaDj4OCg8D9O/f3RDi1OGll.TOQiLNB4jDt9a',
    'Musab Abu Baker',
    1, 'super_admin', 'active', TRUE, FALSE
);

-- ─── Super Admin 2: Adel Sawafta ─────────────────────────────────────────────
INSERT IGNORE INTO users (
    email, password_hash, full_name,
    role_id, user_type, status, email_verified,
    must_change_password
) VALUES (
    'adel.sawafta@cardcovefzc.com',
    '$2b$12$WfV.vgc0JBTf.FvrwsQvz.pJMinKTyBmjUhLvHKsSHsQD1CKJPuIa',
    'Adel Sawafta',
    1, 'super_admin', 'active', TRUE, FALSE
);

-- ─── Super Admin 3: Adel (Gmail) ─────────────────────────────────────────────
INSERT IGNORE INTO users (
    email, password_hash, full_name,
    role_id, user_type, status, email_verified,
    must_change_password
) VALUES (
    'eng.adel@gmail.com',
    '$2b$12$mP4/28uH77HxdCnKuXk/meZTuXVTKoGA4tLNUtNueDBSnl7qaT4/e',
    'Adel',
    1, 'super_admin', 'active', TRUE, FALSE
);

-- ─── Create wallets for all three ────────────────────────────────────────────
INSERT IGNORE INTO wallets (user_id, balance, currency, status)
SELECT user_id, 0.00, 'USD', 'active'
FROM users
WHERE email IN (
    'musab.abubaker@cardcovefzc.com',
    'adel.sawafta@cardcovefzc.com',
    'eng.adel@gmail.com'
);

-- ============================================
-- COMPLETED
-- ============================================

SELECT 'Full schema migration completed successfully!' AS status;
SELECT COUNT(*) AS total_tables
FROM information_schema.tables
WHERE table_schema = 'cardcove_db';

SELECT
    u.user_id,
    u.email,
    u.full_name,
    u.user_type,
    u.status
FROM users u
WHERE u.user_type = 'super_admin'
ORDER BY u.user_id;
