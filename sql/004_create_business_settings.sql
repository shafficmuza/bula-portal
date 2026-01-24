-- Business Settings Table
-- Stores all configurable business settings including branding, theme, and captive portal customization

CREATE TABLE IF NOT EXISTS business_settings (
  id INT PRIMARY KEY DEFAULT 1,
  -- Business Information
  business_name VARCHAR(255) DEFAULT 'BUULAS INVESTMENTS',
  tagline VARCHAR(255) DEFAULT 'WiFi Hotspot Service',
  address TEXT,
  phone VARCHAR(50),
  email VARCHAR(255),
  website VARCHAR(255),

  -- Branding
  logo_url VARCHAR(500),
  favicon_url VARCHAR(500),

  -- Captive Portal Customization
  portal_title VARCHAR(255) DEFAULT 'Welcome to WiFi',
  portal_welcome_text TEXT DEFAULT 'Connect to high-speed internet',
  portal_custom_css TEXT,
  portal_background_url VARCHAR(500),
  portal_background_color VARCHAR(20) DEFAULT '#f7f8fa',

  -- Theme Settings
  primary_color VARCHAR(20) DEFAULT '#0ea56b',
  primary_light VARCHAR(20) DEFAULT '#e6f6ef',
  primary_dark VARCHAR(20) DEFAULT '#0b8a59',
  theme_mode ENUM('light', 'dark', 'auto') DEFAULT 'light',

  -- Social Media Links
  facebook_url VARCHAR(500),
  twitter_url VARCHAR(500),
  instagram_url VARCHAR(500),

  -- Terms and Privacy
  terms_url VARCHAR(500),
  privacy_url VARCHAR(500),
  terms_text TEXT,

  -- Operational Settings
  support_phone VARCHAR(50),
  support_email VARCHAR(255),
  support_hours VARCHAR(255),

  -- Metadata
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Ensure only one row exists
  CONSTRAINT chk_single_row CHECK (id = 1)
);

-- Insert default settings row
INSERT IGNORE INTO business_settings (id) VALUES (1);

-- Show the created table structure
DESCRIBE business_settings;
