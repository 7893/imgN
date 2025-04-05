import { Fetcher } from '@cloudflare/workers-types';

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
}

/**
 * 队列消息载荷
 */
export interface QueueMessagePayload {
    page: number;
}

/**
 * 同步页面处理结果
 */
export interface SyncPageResult {
    success: boolean;
    photoCount: number;
    error?: string;
} 