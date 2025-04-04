// src/handlers.ts
import { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { Env, UnsplashPhoto } from './types';
import { fetchLatestPhotos } from './unsplash'; // 获取 oldest, 数量在下面调用时指定
import { upsertPhotoMetadataBatch } from './database';
import { uploadImageToR2 } from './storage';
import { getFolderNameFromTags } from './utils'; // *** 从 utils.ts 导入 ***

// --- CORS 辅助函数 ---
const corsHeadersMap = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

function addCorsHeaders(response: Response): void {
    Object.entries(corsHeadersMap).forEach(([key, value]) => {
        response.headers.set(key, value);
    });
}

function handleOptions(request: Request): Response {
    if (request.headers.get('Origin') !== null &&
        request.headers.get('Access-Control-Request-Method') !== null &&
        request.headers.get('Access-Control-Request-Headers') !== null) {
        return new Response(null, { headers: corsHeadersMap });
    } else {
        return new Response(null, { headers: { Allow: 'GET, HEAD, POST, OPTIONS' } });
    }
}

// --- Worker 事件处理程序 ---

/**
 * 处理 HTTP Fetch 请求 (状态页面)
 */
export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // (此函数内容保持不变，仍然是之前的状态页面逻辑)
    console.log(`[${new Date().toISOString()}] Received fetch request: ${request.url}`);
    if (request.method === 'OPTIONS') { return handleOptions(request); }
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
        const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>imgn-sync-worker Status</title><style>body{font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding:2em; line-height:1.6;}h1{color:#333;}p{color:#555;}code{background-color:#f4f4f4; padding:2px 4px; border-radius:3px;}</style></head><body><h1>imgn-sync-worker Status</h1><p>✅ This Worker is running!</p><p>Its main purpose is to periodically sync images from Unsplash based on a Cron schedule (fetching oldest first).</p><p>You can monitor its activity using <code>wrangler tail imgn-sync-worker</code>.</p><hr><p><em>Current server time: ${new Date().toISOString()}</em></p></body></html>`;
        const response = new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
        addCorsHeaders(response); return response;
    } else { const response = new Response('Not Found', { status: 404 }); addCorsHeaders(response); return response; }
}

/**
 * 处理 Cron Scheduled 事件 (同步 Unsplash 数据)
 */
export async function handleScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[${new Date().toISOString()}] Cron job triggered: Starting Unsplash sync (Trigger: ${controller.cron})... Fetching oldest first.`);

    try {
        // 1. 获取 Unsplash 照片元数据 (从 oldest 获取, 每次 30 张)
        console.log("Fetching photo batch from Unsplash...");
        const photos: UnsplashPhoto[] = await fetchLatestPhotos(env, 1, 30); // *** 修改为 30 ***

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
            const imageUrlToDownload = photo?.urls?.raw ?? photo?.urls?.regular; // 优先 RAW URL

            if (photoId && imageUrlToDownload) {
                // --- 使用导入的 getFolderNameFromTags ---
                const folderName = getFolderNameFromTags(photo.tags);
                const r2Key = `${folderName}/${photoId}`;
                console.log(`Queueing R2 upload for photo ID: ${photoId} to key: ${r2Key}`);
                // -------------------------------------

                // 将上传操作包裹在 Promise 中，传递完整 key
                return uploadImageToR2(env.IMAGE_BUCKET, r2Key, imageUrlToDownload)
                    .then(() => { /* 成功日志在 upload 函数内部 */ })
                    .catch(err => { /* 错误日志在 upload 函数内部 */ });
            } else {
                if (!photoId) console.warn("Skipping R2 upload due to missing photo ID.");
                if (!imageUrlToDownload) console.warn(`Skipping R2 upload for ${photoId} due to missing image URL.`);
                return Promise.resolve(); // 返回 resolved Promise 避免阻塞 allSettled
            }
        });

        // 等待所有 R2 上传尝试完成
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