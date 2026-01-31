-- Create payment_logs table for transaction audit trail
-- Run this on the portal database

CREATE TABLE IF NOT EXISTS payment_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT,
    provider_code VARCHAR(50) NOT NULL,
    transaction_ref VARCHAR(100),
    provider_tx_id VARCHAR(100),
    amount DECIMAL(15, 2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'UGX',
    status ENUM('initiated', 'pending', 'processing', 'success', 'failed', 'cancelled') DEFAULT 'initiated',
    status_message TEXT,
    request_payload JSON,
    response_payload JSON,
    customer_msisdn VARCHAR(20),
    payment_method VARCHAR(50),
    initiated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,

    INDEX idx_order_id (order_id),
    INDEX idx_provider_code (provider_code),
    INDEX idx_transaction_ref (transaction_ref),
    INDEX idx_provider_tx_id (provider_tx_id),
    INDEX idx_status (status),
    INDEX idx_initiated_at (initiated_at),
    INDEX idx_customer_msisdn (customer_msisdn),

    CONSTRAINT fk_payment_logs_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
