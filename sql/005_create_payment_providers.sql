-- Create payment_providers table for storing payment gateway credentials
-- Run this on the portal database

CREATE TABLE IF NOT EXISTS payment_providers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider_code VARCHAR(50) NOT NULL UNIQUE,
    display_name VARCHAR(100) NOT NULL,
    is_enabled TINYINT(1) DEFAULT 0,
    environment ENUM('test', 'live') DEFAULT 'test',
    credentials JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_provider_code (provider_code),
    INDEX idx_is_enabled (is_enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default providers (disabled by default)
INSERT IGNORE INTO payment_providers (provider_code, display_name, is_enabled, environment, credentials) VALUES
('flutterwave', 'Flutterwave', 0, 'test', JSON_OBJECT('public_key', '', 'secret_key', '', 'webhook_hash', '')),
('yopayments', 'Yo Payments', 0, 'test', JSON_OBJECT('api_username', '', 'api_password', '', 'account_number', ''));
