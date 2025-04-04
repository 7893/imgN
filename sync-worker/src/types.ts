// src/types.ts

/**
 * 定义环境变量、绑定和 Secrets 的类型接口。
 * 名称需要与 wrangler.jsonc 中的 binding 名称严格匹配。
 */
export interface Env {
    DB: D1Database;
    IMAGE_BUCKET: R2Bucket;
    UNSPLASH_ACCESS_KEY: string;
    // KV_CACHE?: KVNamespace; // 如果配置了 KV 绑定，取消注释
}

/**
 * Unsplash API 返回的 Photo 对象的部分结构 (只包含我们用到的字段)
 * 定义更完整的类型有助于代码健壮性。
 */
export interface UnsplashPhoto {
    id: string;
    description: string | null;
    alt_description: string | null;
    color: string | null;
    blur_hash: string | null;
    width: number;
    height: number;
    created_at: string | null;
    updated_at: string | null;
    likes: number | null;
    views?: number | null; // 可能不存在
    downloads?: number | null; // 可能不存在
    slug: string | null;
    urls: {
        raw: string;
        full: string;
        regular: string;
        small: string;
        thumb: string;
    } | null;
    links: {
        self: string;
        html: string;
        download: string;
        download_location: string;
    } | null;
    user: {
        id: string;
        username: string;
        name: string | null;
        portfolio_url: string | null;
        bio: string | null;
        location: string | null;
        links: {
            self: string;
            html: string;
            photos: string;
            likes: string;
            portfolio: string;
            following: string;
            followers: string;
        } | null;
        profile_image: {
            small: string;
            medium: string;
            large: string;
        } | null;
        // ... 其他 user 字段
    } | null;
    location?: { // location 对象本身可能不存在
        name: string | null;
        city: string | null;
        country: string | null;
        position?: { // position 可能不存在
            latitude: number | null;
            longitude: number | null;
        } | null;
    } | null;
    exif?: { // exif 对象可能不存在
        make: string | null;
        model: string | null;
        exposure_time: string | null;
        aperture: string | null;
        focal_length: string | null;
        iso: number | null;
    } | null;
    tags?: { // tags 数组可能不存在
        title?: string; // tag 对象可能没有 title
        type?: string;
    }[];
}

/**
 * (可选) 定义我们存入 D1 的数据结构接口
 */
// export interface ImageMetadata {
//   id: string;
//   description?: string | null;
//   // ... 其他字段 ...
// }