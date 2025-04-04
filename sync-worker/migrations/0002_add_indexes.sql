-- Migration 0002: Add indexes to images_metadata table
CREATE INDEX IF NOT EXISTS idx_imgmeta_created_at ON img3_metadata (created_at_api);
CREATE INDEX IF NOT EXISTS idx_imgmeta_likes ON img3_metadata (likes);
CREATE INDEX IF NOT EXISTS idx_imgmeta_updated_at ON img3_metadata (updated_at_api);
