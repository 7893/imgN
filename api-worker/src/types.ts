// sync-worker/src/types.ts

import { DurableObjectNamespace, Queue } from '@cloudflare/workers-types';

export interface Env {
    DB: D1Database;
    KV_CACHE: KVNamespace; // <--- 确保 KV 绑定存在且名称匹配
    SYNC_COORDINATOR_DO: DurableObjectNamespace;
    SYNC_TASK_QUEUE: Queue;
}

export interface Env {
    DB: D1Database;
    IMAGE_BUCKET: R2Bucket;
    // KV_CACHE?: KVNamespace;

    // Secrets
    UNSPLASH_ACCESS_KEY: string;
    API_WORKER_URL_SECRET: string; // 用于回调 API Worker 的 URL (需要设置为 Secret)
}

// 定义队列消息的载荷类型
export interface QueueMessagePayload {
    page: number; // 要处理的页码
    // 可以添加其他需要传递的信息，例如重试次数等
}

// UnsplashPhoto 接口定义 (保持不变)
export interface UnsplashPhoto {
    id: string;
    // ... 其他字段 ...
    tags?: { title?: string; type?: string; }[];
    urls: { raw: string; regular: string; /* ... */ } | null;
    user: { /* ... */ } | null;
    location?: { /* ... */ } | null;
    exif?: { /* ... */ } | null;
}
