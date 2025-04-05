// sync-worker/src/types.ts

import { DurableObjectNamespace, Queue } from '@cloudflare/workers-types';
import { QueueMessagePayload } from './api-types';

export interface Env {
    // 数据库
    DB: D1Database;
    
    // 存储
    KV_CACHE: KVNamespace;
    IMAGE_BUCKET: R2Bucket;
    
    // Durable Objects
    SYNC_COORDINATOR_DO: DurableObjectNamespace;
    
    // 队列
    SYNC_TASK_QUEUE: Queue<QueueMessagePayload>;
    
    // Secrets
    UNSPLASH_ACCESS_KEY: string;
    API_WORKER_URL_SECRET: string;
}

// 注意：QueueMessagePayload 已移至 api-types.ts

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
