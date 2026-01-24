-- Update admin_users table with additional columns
-- Run this on the portal database

-- Add updated_at column
ALTER TABLE admin_users
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at;

-- Add last_login column
ALTER TABLE admin_users
ADD COLUMN IF NOT EXISTS last_login TIMESTAMP NULL DEFAULT NULL AFTER updated_at;

-- Add created_by column (who created this user)
ALTER TABLE admin_users
ADD COLUMN IF NOT EXISTS created_by BIGINT DEFAULT NULL AFTER last_login;

-- Create index on role for filtering
CREATE INDEX IF NOT EXISTS idx_admin_users_role ON admin_users(role);
