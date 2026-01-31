-- Create withdrawals table for tracking withdrawal requests
-- Run this on the portal database

CREATE TABLE IF NOT EXISTS withdrawals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    withdrawal_ref VARCHAR(50) NOT NULL UNIQUE,
    amount DECIMAL(15, 2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'UGX',
    destination_type ENUM('bank_account', 'mobile_money') NOT NULL,
    destination_details JSON,
    status ENUM('pending', 'processing', 'completed', 'failed', 'cancelled') DEFAULT 'pending',
    requested_by INT,
    approved_by INT,
    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    notes TEXT,

    INDEX idx_withdrawal_ref (withdrawal_ref),
    INDEX idx_status (status),
    INDEX idx_requested_at (requested_at),
    INDEX idx_requested_by (requested_by),

    CONSTRAINT fk_withdrawals_requested_by FOREIGN KEY (requested_by) REFERENCES admin_users(id) ON DELETE SET NULL,
    CONSTRAINT fk_withdrawals_approved_by FOREIGN KEY (approved_by) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
