CREATE DATABASE IF NOT EXISTS geo_lo;
USE geo_lo;

CREATE TABLE IF NOT EXISTS organizations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    slug VARCHAR(80) NULL,
    contact_email VARCHAR(120) NULL,
    phone VARCHAR(30) NULL,
    notes VARCHAR(255) NULL,
    plan VARCHAR(32) NULL,
    plan_name VARCHAR(60) NULL,
    onboarding_request_id INT NULL,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_org_slug (slug)
);

-- Companies that came through the "Get Started" form on the marketing site.
-- The Geo-Lo owner registers each organization from one of these rows.
CREATE TABLE IF NOT EXISTS onboarding_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    organization VARCHAR(190) NOT NULL,
    contact_email VARCHAR(190) NOT NULL,
    phone VARCHAR(60) DEFAULT NULL,
    admin_name VARCHAR(190) DEFAULT NULL,
    admin_email VARCHAR(190) DEFAULT NULL,
    description TEXT,
    plan VARCHAR(32) NOT NULL DEFAULT 'free',
    plan_name VARCHAR(60) NOT NULL DEFAULT 'Free',
    amount_paid DECIMAL(10,2) NOT NULL DEFAULT 0,
    currency VARCHAR(8) NOT NULL DEFAULT 'GHS',
    paystack_ref VARCHAR(128) DEFAULT NULL,
    status ENUM('new','contacted','onboarded') NOT NULL DEFAULT 'new',
    organization_id INT NULL,
    email_sent_at DATETIME DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_paystack_ref (paystack_ref)
);

-- Workers table
CREATE TABLE workers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    organization_id INT NULL,
    employee_id VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    pin_hash VARCHAR(255),
    password_hash VARCHAR(255),
    shift_id INT NULL,
    assigned_location_id INT NULL,
    device_fingerprint VARCHAR(128) NULL,
    device_bound TINYINT(1) DEFAULT 0,
    require_face TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    -- Email and employee ID are unique per organization, so two companies can each
    -- have their own "EMP-001" or reuse the same worker address.
    UNIQUE KEY uniq_org_employee (organization_id, employee_id),
    UNIQUE KEY uniq_org_email (organization_id, email),
    KEY idx_workers_org (organization_id)
);

-- Workplace locations table
CREATE TABLE locations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    organization_id INT NULL,
    name VARCHAR(100) NOT NULL,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    radius_meters INT DEFAULT 100,
    polygon TEXT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_locations_org (organization_id)
);

-- Attendance records table
CREATE TABLE attendance (
    id INT AUTO_INCREMENT PRIMARY KEY,
    worker_id INT NOT NULL,
    -- Copied from the worker so attendance can be scoped to one organization
    -- without always joining workers.
    organization_id INT NULL,
    location_id INT NOT NULL,
    check_in DATETIME NOT NULL,
    check_out DATETIME,
    check_in_lat DECIMAL(10, 8),
    check_in_lng DECIMAL(11, 8),
    check_out_lat DECIMAL(10, 8),
    check_out_lng DECIMAL(11, 8),
    status ENUM('present', 'absent', 'late') DEFAULT 'present',
    overtime_minutes INT DEFAULT 0,
    notes VARCHAR(255) NULL,
    is_manual TINYINT(1) DEFAULT 0,
    outside_geofence TINYINT(1) DEFAULT 0,
    missed_checkout TINYINT(1) DEFAULT 0,
    corrected_by INT NULL,
    accuracy_meters INT NULL,
    device_fingerprint VARCHAR(128) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_attendance_org (organization_id),
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE,
    FOREIGN KEY (location_id) REFERENCES locations(id)
);

-- Insert default location
INSERT INTO locations (name, latitude, longitude, radius_meters, is_default) 
VALUES ('Main Office', 40.7128, -74.0060, 100, TRUE);

-- 128-D face embeddings captured in the browser via face-api.js. Only the
-- descriptor (JSON array of 128 floats) reaches the server; no image is stored.
-- `phash` is kept nullable for rows written by the retired aHash engine.
CREATE TABLE IF NOT EXISTS worker_faces (
    id INT AUTO_INCREMENT PRIMARY KEY,
    worker_id INT NOT NULL,
    phash VARCHAR(128) NULL,
    descriptor TEXT NULL,
    engine VARCHAR(32) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
);

-- Short-lived, single-use tokens issued after a correct worker PIN. A session is
-- only created once the face enroll/verify step against this challenge passes.
CREATE TABLE IF NOT EXISTS login_challenges (
    id INT AUTO_INCREMENT PRIMARY KEY,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    role ENUM('admin','worker') NOT NULL,
    user_id INT NOT NULL,
    purpose VARCHAR(24) NOT NULL DEFAULT 'login_face',
    device_fingerprint VARCHAR(128) NULL,
    attempts INT NOT NULL DEFAULT 0,
    consumed TINYINT(1) NOT NULL DEFAULT 0,
    expires_at DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_login_challenges_user (role, user_id)
);

-- One-time reset codes emailed to workers, organization admins and the owner.
-- The code itself is hashed; only the hash is stored.
CREATE TABLE IF NOT EXISTS password_reset_codes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_type VARCHAR(16) NOT NULL,
    account_id INT NOT NULL,
    email VARCHAR(190) NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    used TINYINT(1) NOT NULL DEFAULT 0,
    expires_at DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_account (account_type, account_id)
);

CREATE TABLE IF NOT EXISTS admins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    privilege VARCHAR(20) NOT NULL DEFAULT 'admin',
    organization_id INT NULL,
    -- The owner signs in as boss@geo-lo (not a real inbox); reset codes go here instead.
    recovery_email VARCHAR(190) NULL,
    must_change_password TINYINT(1) NOT NULL DEFAULT 0,
    password_changed_at DATETIME NULL,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    role ENUM('admin','worker') NOT NULL,
    user_id INT NOT NULL,
    device_fingerprint VARCHAR(128) NULL,
    expires_at DATETIME NOT NULL,
    last_seen DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS shifts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    organization_id INT NULL,
    name VARCHAR(100) NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    work_days VARCHAR(32) NOT NULL DEFAULT '1,2,3,4,5',
    late_grace_minutes INT DEFAULT 10,
    overtime_after_minutes INT DEFAULT 0,
    break_minutes INT DEFAULT 0,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_shifts_org (organization_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    actor_role VARCHAR(20) NOT NULL,
    actor_id INT NULL,
    organization_id INT NULL,
    action VARCHAR(80) NOT NULL,
    entity VARCHAR(50) NOT NULL,
    entity_id INT NULL,
    details TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_audit_log_org (organization_id)
);

CREATE TABLE IF NOT EXISTS alerts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    type VARCHAR(50) NOT NULL,
    worker_id INT NULL,
    attendance_id INT NULL,
    organization_id INT NULL,
    message VARCHAR(255) NOT NULL,
    is_read TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_alerts_org (organization_id)
);

INSERT INTO shifts (name, start_time, end_time, work_days, late_grace_minutes, overtime_after_minutes, break_minutes)
VALUES ('Standard day', '08:00:00', '17:00:00', '1,2,3,4,5', 10, 0, 60);
