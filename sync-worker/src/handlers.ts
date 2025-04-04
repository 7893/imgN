// ~/imgN/sync-worker/src/handlers.ts
import { ExecutionContext, MessageBatch } from '@cloudflare/workers-types';
import { Env, UnsplashPhoto, QueueMessagePayload } from './types'; // 假设类型在 types.ts
import { fetchLatestPhotos } from './unsplash';
import { upsertPhotoMetadataBatch } from './database';
import { uploadImageToR2 } from './storage';
import { getFolderNameFromTags } from './utils'; // 从 utils.ts 导入

// --- CORS Helper Functions ---
const corsHeadersMap = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', // Sync worker fetch 只需 GET/OPTIONS
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

function addCorsHeaders(response: Response): void {
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeadersMap).forEach(([key, value]) => { newHeaders.set(key, value); });
    // 注意：这里没有返回 new Response，因为 handleFetch 会做。如果需要独立函数，需要返回 new Response。
    // 为了安全，直接修改传入的 Response Headers 可能更好
    Object.entries(corsHeadersMap).forEach(([key, value]) => { response.headers.set(key, value); });
}

function handleOptions(request: Request): Response {
    if (request.headers.get('Origin') !== null &&
        request.headers.get('Access-Control-Request-Method') !== null &&
        request.headers.get('Access-Control-Request-Headers') !== null) {
        return new Response(null, { headers: corsHeadersMap });
    } else { return new Response(null, { headers: { Allow: 'GET, HEAD, OPTIONS' } }); }
}


// --- Worker 事件处理程序 ---

/**
 * 处理 HTTP Fetch 请求 (状态页面)
 */
export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    console.log(`[${new Date().toISOString()}] Received fetch request: ${request.url}`);
    if (request.method === 'OPTIONS') { return handleOptions(request); }
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
        const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>imgn-sync-worker Status</title><style>body{font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding:2em; line-height:1.6;}h1{color:#333;}p{color:#555;}code{background-color:#f4f4f4; padding:2px 4px; border-radius:3px;}</style></head><body><h1>imgn-sync-worker Status</h1><p>✅ This Worker is running!</p><p>It processes tasks from a Cloudflare Queue.</p><p>You can monitor its activity using <code>wrangler tail imgn-sync-worker</code>.</p><hr><p><em>Current server time: ${new Date().toISOString()}</em></p></body></html>`;
        const response = new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
        addCorsHeaders(response); // 直接修改传入的 Response
        return response;
    } else {
        const response = new Response('Not Found', { status: 404 });
        addCorsHeaders(response);
        return response;
    }
}

/**
 * 处理来自 Cloudflare Queue 的消息批次
 */
export async function handleQueue(batch: MessageBatch<QueueMessagePayload>, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[${new Date().toISOString()}] Received queue batch with ${batch.messages.length} messages.`);

    // 处理批次中的每条消息
    for (const message of batch.messages) {
        const messageId = message.id;
        let pageToProcess: number | undefined;
        let processingSuccess = false; // 标记此消息是否成功处理
        let errorMessageForReport: string | null = null;

        console.log(`Processing message ID: ${messageId}`);

        try {
            const payload = message.body; // message.body 已是解析好的对象
            if (!payload || typeof payload.page !== 'number' || payload.page <= 0) {
                console.error(`Invalid message payload received for ID ${messageId}:`, payload);
                message.ack(); // 确认无效消息，不再重试
                continue; // 处理下一条消息
            }
            pageToProcess = payload.page; // 记录当前处理的页码
            console.log(`Processing task for page ${pageToProcess}...`);

            // 1. 获取 Unsplash 数据
            const photos: UnsplashPhoto[] = await fetchLatestPhotos(env, pageToProcess, 30);

            if (!photos || photos.length === 0) {
                console.log(`No photos found on Unsplash page ${pageToProcess}. Considering page processed.`);
                processingSuccess = true; // 认为是成功处理（该页已无内容）
            } else {
                // 2. Upsert D1 元数据 (需要 await 确保完成，除非你想让 R2 和 D1 并行)
                console.log(`Attempting D1 upsert for ${photos.length} photos on page ${pageToProcess}...`);
                const validPhotosForDb = photos.filter(p => p && p.id);
                if (validPhotosForDb.length > 0) {
                    await upsertPhotoMetadataBatch(env.DB, validPhotosForDb); // 等待 D1 完成
                    console.log(`D1 upsert finished for page ${pageToProcess}.`);
                } else {
                    console.log("No valid photos with IDs found for D1 upsert on page ${pageToProcess}.");
                }

                // 3. 分批上传 R2 图片
                console.log(`Attempting R2 upload for ${photos.length} images on page ${pageToProcess}...`);
                const r2BatchSize = 5; // <--- R2 并发批次大小
                let r2SuccessCount = 0;
                let r2FailCount = 0;
                for (let i = 0; i < photos.length; i += r2BatchSize) {
                    const photoBatch = photos.slice(i, i + r2BatchSize);
                    console.log(` Processing R2 upload sub-batch ${Math.floor(i / r2BatchSize) + 1} (size: ${photoBatch.length})...`);

                    const batchPromises = photoBatch.map(async (photo) => { // 使用 async map
                        const photoId = photo?.id;
                        const imageUrlToDownload = photo?.urls?.raw ?? photo?.urls?.regular;

                        if (photoId && imageUrlToDownload) {
                            const folderName = getFolderNameFromTags(photo.tags);
                            const r2Key = `${folderName}/${photoId}`;
                            try {
                                const existingObject = await env.IMAGE_BUCKET.head(r2Key);
                                if (existingObject !== null) {
                                    console.log(`  Skipping R2 upload for key: ${r2Key} (already exists).`);
                                } else {
                                    console.log(`  Starting R2 upload for key: ${r2Key}`);
                                    await uploadImageToR2(env.IMAGE_BUCKET, r2Key, imageUrlToDownload);
                                    // 成功计数可以在 uploadImageToR2 内部日志看到，这里不再重复计数
                                }
                            } catch (uploadError) {
                                console.error(`  Failed R2 processing for key: ${r2Key}`, uploadError);
                                r2FailCount++; // 记录明确的失败
                            }
                        } else {
                            // 无效数据也算处理失败
                            r2FailCount++;
                        }
                    });
                    // 等待当前这个小批次完成
                    await Promise.allSettled(batchPromises);
                    console.log(`  R2 upload sub-batch ${Math.floor(i / r2BatchSize) + 1} settled.`);
                } // end for loop for R2 batches
                console.log(`R2 upload attempts for page ${pageToProcess} finished. Failures recorded: ${r2FailCount}`);
                // 即使 R2 有部分失败，我们也认为页面处理尝试已完成
                processingSuccess = true;
            } // end else (photos found)

            // 如果整个 try 块没有抛出错误，确认消息
            message.ack();
            console.log(`Message ID ${messageId} (Page ${pageToProcess}) acknowledged.`);

        } catch (error: any) {
            // 处理整个页面处理过程中的捕获到的错误
            console.error(`Failed to process message ID ${messageId} (Page ${pageToProcess}):`, error);
            errorMessageForReport = error.message || "Unknown error during queue processing";

            // 决定是否重试
            const retryableErrors = ["D1_ERROR", "R2 Error", "Failed to download"]; // 示例：定义哪些错误可以重试
            let shouldRetry = false;
            if (errorMessageForReport) {
                shouldRetry = retryableErrors.some(e => errorMessageForReport.includes(e));
            }

            if (shouldRetry && message.attempts < 3) { // 限制重试次数
                console.warn(`Retrying message ID ${messageId} (Attempt ${message.attempts + 1})`);
                message.retry({ delaySeconds: 30 }); // 30秒后重试
            } else {
                console.error(`Giving up on message ID ${messageId} after ${message.attempts} attempts or due to non-retryable error.`);
                message.ack(); // 放弃并确认消息，防止无限循环
                // 记录下这个无法处理的页码或错误详情，以便后续分析
            }
        } finally {
            // --- 4. 回调 API Worker 报告本页处理结果 ---
            // 只有在 pageToProcess 有效时才进行回调
            if (pageToProcess !== undefined) {
                console.log(`Reporting status for page ${pageToProcess} back to API worker...`);
                const reportPayload = processingSuccess
                    ? { pageCompleted: pageToProcess }
                    : { error: `Failed to process page ${pageToProcess}: ${errorMessageForReport}` };

                const reportUrl = `${env.API_WORKER_URL_SECRET}/report-sync-page`;

                // 使用 ctx.waitUntil 确保回调请求能发出
                ctx.waitUntil(
                    fetch(reportUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(reportPayload),
                    })
                        .then(async (res) => {
                            if (!res.ok) {
                                console.error(`[Callback Error] Failed to report page ${pageToProcess} status to API worker: ${res.status} ${res.statusText}`, await res.text());
                            } else {
                                console.log(`[Callback Success] Successfully reported page ${pageToProcess} status to API worker.`);
                            }
                        })
                        .catch(err => {
                            console.error(`[Callback Network Error] Error sending report for page ${pageToProcess} to API worker:`, err);
                        })
                );
            } // end if pageToProcess !== undefined
        } // end finally block
    } // end for loop over messages

    console.log(`Finished processing queue batch of ${batch.messages.length} messages.`);
} // <--- handleQueue 函数结束