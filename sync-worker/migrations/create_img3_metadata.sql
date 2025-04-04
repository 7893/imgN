-- 表名: img3_metadata
-- 只包含直接来自 Unsplash API 的字段或其结构化表示

CREATE TABLE img3_metadata (
    -- 核心标识符 (来自 Unsplash ID)
    id TEXT PRIMARY KEY NOT NULL,

    -- 描述性元数据 (来自 API, 可能为 NULL)
    description TEXT,
    alt_description TEXT,
    color TEXT,           -- 主色调 hex
    blur_hash TEXT,       -- BlurHash

    -- 尺寸 (来自 API)
    width INTEGER,
    height INTEGER,

    -- 时间戳 (来自 API, 存储为 TEXT)
    created_at_api TEXT,  -- Unsplash 创建时间
    updated_at_api TEXT,  -- Unsplash 更新时间

    -- 统计数据 (来自 API, 可能为 NULL 或 0)
    likes INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    downloads INTEGER DEFAULT 0,

    -- 结构化数据 (来自 API, 存为 JSON 字符串)
    image_urls TEXT,      -- 包含 raw, full, regular 等 URL 的 JSON 对象
    photo_links TEXT,     -- 包含 self, html, download 等链接的 JSON 对象
    author_details TEXT,  -- 包含作者信息的 user JSON 对象
    location_details TEXT,-- 包含地理位置信息的 location JSON 对象 (可能为 NULL)
    exif_data TEXT,       -- 包含 EXIF 信息的 JSON 对象 (通常仅单图 API 返回, 可能为 NULL)
    tags_data TEXT,       -- 包含 tag 标题的 JSON 数组字符串 (从原始 tags 数组提取 title)

    -- 其他字段 (来自 API)
    slug TEXT             -- Unsplash slug (如果 API 提供)

    -- 注意: 已移除 synced_at 列，因为它不是来自 API 的原始属性
);

-- === 可选索引 (根据需要调整) ===
CREATE INDEX IF NOT EXISTS idx_imgmeta_created_at ON images_metadata (created_at_api);
CREATE INDEX IF NOT EXISTS idx_imgmeta_likes ON images_metadata (likes);
CREATE INDEX IF NOT EXISTS idx_imgmeta_updated_at ON images_metadata (updated_at_api);
-- 如果你需要按作者查询，但直接索引 JSON 列效率不高，可能需要冗余存储 author_username
-- CREATE INDEX IF NOT EXISTS idx_imgmeta_author ON images_metadata (author_username); -- 假设你添加了 author_username 列
