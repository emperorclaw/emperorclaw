-- Migration: monthly reset support
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_reset_month text;
