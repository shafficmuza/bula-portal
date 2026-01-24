-- Create locations table for managing device locations
-- Run this on the portal database

CREATE TABLE IF NOT EXISTS locations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    address VARCHAR(255) DEFAULT NULL,
    description TEXT DEFAULT NULL,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE INDEX idx_name (name),
    INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Update devices table to reference locations
ALTER TABLE devices
    ADD COLUMN location_id INT DEFAULT NULL AFTER location,
    ADD CONSTRAINT fk_devices_location FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL;

-- Create index for location_id
CREATE INDEX idx_devices_location_id ON devices(location_id);
