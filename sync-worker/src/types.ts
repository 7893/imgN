// /home/ubuntu/imgN/sync-worker/src/types.ts (修正后)
import { D1Database, R2Bucket, KVNamespace, Fetcher } from '@cloudflare/workers-types'; // 引入所需类型

/**
 * Worker 环境绑定
 */
export interface Env {
    // --- 数据库绑定 ---
    DB: D1Database;

    // --- 存储绑定 ---
    IMAGE_BUCKET: R2Bucket;
    KV_CACHE?: KVNamespace; // 可选的 KV 缓存

    // --- Service Binding ---
    API_WORKER: Fetcher; // 用于回调 API Worker

    // --- Secrets ---
    // !! 添加缺失的 Unsplash API Key 绑定 !!
    UNSPLASH_ACCESS_KEY: string;
}

/**
 * 队列消息载荷
 */
export interface QueueMessagePayload {
    page: number;
    // 可以保留 retryCount 等字段，如果队列或逻辑中会用到
    retryCount?: number;
    lastError?: string;
    timestamp?: number;
}

/**
 * 同步页面处理结果接口 (从 ./types.ts 导出)
 */
export interface SyncPageResult {
    success: boolean;
    photoCount: number;
    error?: string;
}

// 可以将 UnsplashPhoto 接口也定义或导入到这里，供 sync-logic 使用
export interface UnsplashPhoto {
    id: string;
    description: string | null;
    alt_description: string | null;
    color: string | null;
    blur_hash: string | null;
    width: number;
    height: number;
    created_at: string | null; // 对应 D1 的 created_at_api
    updated_at: string | null; // 对应 D1 的 updated_at_api
    likes: number | null;
    views?: number | null;     // D1 中似乎有 views 字段
    downloads?: number | null; // D1 中似乎有 downloads 字段
    slug: string | null;
    urls: { raw: string; full: string; regular: string; small: string; thumb: string; } | null;
    links: { self: string; html: string; download: string; download_location: string; } | null;
    user: { id: string; username: string; name: string | null; /* etc. */ } | null;
    location?: { name: string | null; city: string | null; country: string | null; /* etc. */ } | null;
    exif?: { /* etc. */ } | null;
    tags?: { title?: string; type?: string; }[];
}