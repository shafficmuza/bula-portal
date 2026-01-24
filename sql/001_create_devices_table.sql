-- Create devices table for WiFi router/access point management
-- Run this on the portal database

CREATE TABLE IF NOT EXISTS devices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    ip_address VARCHAR(45) NOT NULL UNIQUE,
    shortname VARCHAR(50) NOT NULL,
    secret VARCHAR(255) NOT NULL,
    vendor ENUM('mikrotik', 'ubiquiti', 'cisco', 'other') DEFAULT 'other',
    location VARCHAR(100) DEFAULT NULL,
    description TEXT DEFAULT NULL,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_ip_address (ip_address),
    INDEX idx_vendor (vendor),
    INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ensure NAS table exists in RADIUS database (standard FreeRADIUS table)
-- This should already exist if FreeRADIUS is properly configured
-- If not, run this on the radius database:
/*
CREATE TABLE IF NOT EXISTS nas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nasname VARCHAR(128) NOT NULL,
    shortname VARCHAR(32),
    type VARCHAR(30) DEFAULT 'other',
    ports INT,
    secret VARCHAR(60) DEFAULT 'secret' NOT NULL,
    server VARCHAR(64),
    community VARCHAR(50),
    description VARCHAR(200) DEFAULT 'RADIUS Client',

    INDEX idx_nasname (nasname)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
*/
