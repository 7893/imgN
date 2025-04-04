-- schema.sql for Cloudflare D1 (SQLite syntax - Author Info Merged)
DROP TABLE IF EXISTS image_metadata;

CREATE TABLE image_metadata (
    photo_id TEXT PRIMARY KEY NOT NULL,
    photo_url TEXT,
    file_size INTEGER,
    category TEXT,
    resolution TEXT,
    color TEXT,
    author_info TEXT,        -- 合并作者信息为 JSON 字符串
    exif TEXT,               -- 存储为 JSON 字符串
    location TEXT,           -- 存储为 JSON 字符串
    image_urls TEXT,         -- 存储为 JSON 字符串
    likes INTEGER,
    views INTEGER,
    downloads INTEGER,
    updated_at TEXT,         -- 存储为 ISO 8601 字符串
    tags TEXT,               -- 存储为 JSON 数组字符串
    public_domain INTEGER,   -- 使用 0 (false) 或 1 (true)
    slug TEXT
);

-- Optional Indexes
CREATE INDEX IF NOT EXISTS idx_image_metadata_category ON image_metadata (category);
CREATE INDEX IF NOT EXISTS idx_image_metadata_updated_at ON image_metadata (updated_at);
