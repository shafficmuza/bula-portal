-- Migration: Add MikroTik auto-login support
-- Date: 2026-01-30

-- Add MikroTik settings columns to business_settings
ALTER TABLE business_settings
ADD COLUMN IF NOT EXISTS mikrotik_enabled BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS mikrotik_host VARCHAR(255) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS mikrotik_port INT DEFAULT 8728,
ADD COLUMN IF NOT EXISTS mikrotik_username VARCHAR(255) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS mikrotik_password VARCHAR(255) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS mikrotik_hotspot_server VARCHAR(255) DEFAULT NULL;

-- Add MAC tracking columns to orders
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS customer_mac VARCHAR(17) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS customer_ip VARCHAR(45) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS mikrotik_login_url TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS autologin_status ENUM('pending', 'success', 'failed', 'skipped') DEFAULT NULL,
ADD COLUMN IF NOT EXISTS autologin_message VARCHAR(255) DEFAULT NULL;

-- Create mac_bindings table for audit/tracking
CREATE TABLE IF NOT EXISTS mac_bindings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT(20) NOT NULL,
  mac_address VARCHAR(17) NOT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  mikrotik_host VARCHAR(255) DEFAULT NULL,
  binding_type ENUM('ip-binding', 'hotspot-user') DEFAULT 'ip-binding',
  status ENUM('pending', 'active', 'expired', 'removed') DEFAULT 'pending',
  mikrotik_id VARCHAR(50) DEFAULT NULL,
  expires_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_order_id (order_id),
  INDEX idx_mac_address (mac_address),
  INDEX idx_status (status),
  INDEX idx_expires_at (expires_at),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add index on orders for MAC lookup
CREATE INDEX IF NOT EXISTS idx_orders_customer_mac ON orders(customer_mac);

-- Fix provider_tx_id column size for Yo Payments transaction references
ALTER TABLE orders MODIFY COLUMN provider_tx_id VARCHAR(150);
