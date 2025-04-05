// ~/imgN/sync-worker/src/types.ts
import { Fetcher } from '@cloudflare/workers-types'; // <--- 导入 Fetcher

export interface Env {
	DB: D1Database;
	IMAGE_BUCKET: R2Bucket;
	UNSPLASH_ACCESS_KEY: string;   // Secret
	// API_WORKER_BASE_URL: string; // <-- 移除
	API_WORKER: Fetcher;       // <--- 添加 Service Binding 类型
	KV_CACHE?: KVNamespace;    // 可选绑定
}

// 定义队列消息的载荷类型
export interface QueueMessagePayload {
	page: number;
}

// Unsplash API 返回的 Photo 对象的部分结构
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
	views?: number | null;
	downloads?: number | null;
	slug: string | null;
	urls: { raw: string; full: string; regular: string; small: string; thumb: string; } | null;
	links: { self: string; html: string; download: string; download_location: string; } | null;
	user: { id: string; username: string; name: string | null; /* ... 其他 ... */ } | null; // 简化示例
	location?: { name: string | null; city: string | null; country: string | null; /* ... 其他 ... */ } | null;
	exif?: { /* ... */ } | null;
	tags?: { title?: string; type?: string; }[];
}