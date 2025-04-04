// src/handlers.ts
import { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { Env, UnsplashPhoto } from './types'; // 假设类型在 types.ts
import { fetchLatestPhotos } from './unsplash';
import { upsertPhotoMetadataBatch } from './database';
import { uploadImageToR2 } from './storage';

/**
 * 处理 HTTP Fetch 请求
 */
export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    console.log(`[${new Date().toISOString()}] Received fetch request: ${request.url}`);

    // CORS Preflight request handling
    if (request.method === 'OPTIONS') {
        return handleOptions(request);
    }

    // 只提供简单的根路径状态页面
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
        const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>imgn-sync-worker Status</title><style>body{font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding:2em; line-height:1.6;}h1{color:#333;}p{color:#555;}code{background-color:#f4f4f4; padding:2px 4px; border-radius:3px;}</style></head>
		<body><h1>imgn-sync-worker Status</h1><p>✅ This Worker is running!</p><p>Its main purpose is to periodically sync images from Unsplash based on a Cron schedule.</p><p>You can monitor its activity using <code>wrangler tail imgn-sync-worker</code>.</p><hr><p><em>Current server time: ${new Date().toISOString()}</em></p></body></html>`;
        const response = new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
        addCorsHeaders(response); // 添加 CORS 头
        return response;
    } else {
        const response = new Response('Not Found', { status: 404 });
        addCorsHeaders(response);
        return response;
    }
}

/**
 * 处理 Cron Scheduled 事件
 */
export async function handleScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[${new Date().toISOString()}] Cron job triggered: Starting Unsplash sync (Trigger: ${controller.cron})...`);

    try {
        // 1. 获取 Unsplash 照片元数据
        // TODO: 实现更完善的获取逻辑（分页、随机等）
        const photos = await fetchLatestPhotos(env, 1, 10);

        if (!photos || photos.length === 0) {
            console.log("No photos fetched from Unsplash this time.");
            return;
        }

        // 2. 将元数据批量写入 D1 (使用 waitUntil)
        console.log(`Attempting to upsert metadata for ${photos.length} photos to D1...`);
        ctx.waitUntil(
            upsertPhotoMetadataBatch(env.DB, photos)
                .then(results => {
                    console.log(`D1 batch metadata update finished. Results count: ${results?.length ?? 'N/A'}`);
                })
                .catch(err => {
                    console.error('Error during D1 batch operation:', err);
                })
        );

        // 3. 将图片文件逐个上传到 R2 (使用 waitUntil)
        console.log(`Attempting to upload ${photos.length} images to R2...`);
        const r2UploadPromises: Promise<void>[] = photos.map(photo => {
            const photoId = photo?.id;
            const imageUrlToDownload = photo?.urls?.regular ?? photo?.urls?.raw; // 优先 regular

            if (photoId && imageUrlToDownload) {
                // 包裹在 Promise 中，并确保处理错误，避免单个失败影响 Promise.allSettled
                return uploadImageToR2(env.IMAGE_BUCKET, photoId, imageUrlToDownload)
                    .then(() => { /* console.log in uploadImageToR2 handles success */ })
                    .catch(err => { /* console.error in uploadImageToR2 handles failure */ });
            } else {
                console.warn(`Skipping R2 upload for photo (missing ID or URL): ${photoId ?? 'ID missing'}`);
                return Promise.resolve(); // 返回一个 resolved 的 Promise 以免阻塞 Promise.allSettled
            }
        });

        // 等待所有 R2 上传尝试完成 (成功或失败)
        // 使用 allSettled 确保即使个别图片上传失败，也能知道所有任务都已尝试
        ctx.waitUntil(
            Promise.allSettled(r2UploadPromises)
                .then(results => {
                    const fulfilled = results.filter(r => r.status === 'fulfilled').length;
                    const rejected = results.length - fulfilled;
                    console.log(`R2 upload attempts finished. Fulfilled: ${fulfilled}, Rejected: ${rejected}`);
                })
        );

        console.log(`[${new Date().toISOString()}] Cron job: Sync batch processing queued.`);

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Cron job failed unexpectedly:`, error instanceof Error ? error.message : error);
    }
}

// --- CORS Helper Functions ---
// (放在 handlers.ts 或单独的 cors.ts 文件中都可以)
const corsHeadersMap = {
    'Access-Control-Allow-Origin': '*', // 生产环境应替换为你的 Pages 域名
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400', // 预检请求缓存时间 (秒)
};

function addCorsHeaders(response: Response): void {
    Object.entries(corsHeadersMap).forEach(([key, value]) => {
        response.headers.set(key, value);
    });
}

function handleOptions(request: Request): Response {
    // 处理 CORS 预检请求 (OPTIONS)
    if (
        request.headers.get('Origin') !== null &&
        request.headers.get('Access-Control-Request-Method') !== null &&
        request.headers.get('Access-Control-Request-Headers') !== null
    ) {
        // Handle CORS preflight requests.
        return new Response(null, {
            headers: corsHeadersMap,
        });
    } else {
        // Handle standard OPTIONS request.
        return new Response(null, {
            headers: {
                Allow: 'GET, HEAD, POST, OPTIONS',
            },
        });
    }
}