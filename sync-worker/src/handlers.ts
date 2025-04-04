// src/handlers.ts
import { ExecutionContext, MessageBatch } from '@cloudflare/workers-types';
import { Env, UnsplashPhoto, QueueMessagePayload } from './types';
import { fetchLatestPhotos } from './unsplash';
import { upsertPhotoMetadataBatch } from './database';
import { uploadImageToR2 } from './storage';
import { getFolderNameFromTags } from './utils';

// --- CORS Helper Functions (保持不变) ---
const corsHeadersMap = { /* ... */ };
function addCorsHeaders(response: Response): void { /* ... */ }
function handleOptions(request: Request): Response { /* ... */ }

// --- Worker 事件处理程序 ---

/**
 * 处理 HTTP Fetch 请求 (状态页面 - 保持不变)
 */
export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // ... (同上一个版本) ...
	console.log(`[${new Date().toISOString()}] Received fetch request: ${request.url}`);	
	if (request.method === 'OPTIONS') { return handleOptions(request); }	
	const url = new URL(request.url);
	if (url.pathname === '/' || url.pathname === '/health') {
		const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>imgn-sync-worker Status</title><style>body{font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding:2em; line-height:1.6;}h1{color:#333;}p{color:#555;}code{background-color:#f4f4f4; padding:2px 4px; border-radius:3px;}</style></head><body><h1>imgn-sync-worker Status</h1><p>✅ This Worker is running!</p><p>It processes tasks from a Cloudflare Queue.</p><p>You can monitor its activity using <code>wrangler tail imgn-sync-worker</code>.</p><hr><p><em>Current server time: ${new Date().toISOString()}</em></p></body></html>`;
		const response = new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
		addCorsHeaders(response); return response;
	} else { const response = new Response('Not Found', { status: 404 }); addCorsHeaders(response); return response; }
}

/**
 * (已移除) 处理 Cron Scheduled 事件
 * export async function handleScheduled(...) { ... } 
 */

/**
 * 处理来自 Cloudflare Queue 的消息批次
 */
export async function handleQueue(batch: MessageBatch<QueueMessagePayload>, env: Env, ctx: ExecutionContext): Promise<void> {
	console.log(`[${new Date().toISOString()}] Received queue batch with ${batch.messages.length} messages.`);

    // 存储需要回调报告的操作 (Promise)
    const reportingPromises: Promise<any>[] = [];

	// 依次处理批次中的每条消息
	for (const message of batch.messages) {
		console.log(`Processing message ID: ${message.id}`);
		const payload = message.body; // message.body 已经是解析好的对象
        let pageCompleted = -1; // 用于标记此消息对应的页码是否处理成功
        let errorMessage: string | null = null;

		// 检查消息载荷是否符合预期
		if (!payload || typeof payload.page !== 'number' || payload.page <= 0) {
			console.error(`Invalid message payload received:`, payload);
			message.ack(); // 确认消息，防止无限重试无效载荷
			continue; // 处理下一条消息
		}

		const pageToProcess = payload.page;
		console.log(`Processing task for page ${pageToProcess}...`);

		try {
			// 1. 获取该页的 Unsplash 照片元数据
			const photos = await fetchLatestPhotos(env, pageToProcess, 30); // 获取30张

			if (photos && photos.length > 0) {
				// 2. 将元数据批量写入 D1 
                // 注意：这里不再需要 waitUntil，因为 queue handler 的执行时间足够长
                // 而且我们需要知道 D1 操作是否成功，以便决定是否继续 R2 和回调
                console.log(`Attempting D1 upsert for ${photos.length} photos on page ${pageToProcess}...`);
				const d1Results = await upsertPhotoMetadataBatch(env.DB, photos);
                console.log(`D1 upsert finished for page ${pageToProcess}. Results count: ${d1Results?.length ?? 'N/A'}`);
                // 可以添加对 d1Results 的检查

				// 3. 逐个（或小批量）处理 R2 上传
				console.log(`Attempting R2 upload for ${photos.length} images on page ${pageToProcess}...`);
                let r2SuccessCount = 0;
                let r2FailCount = 0;
                const r2UploadPromises = photos.map(async (photo) => { // 改为 async map 以便在内部 await
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
                                r2SuccessCount++;
                            }
                        } catch (uploadError) {
                            console.error(`  Failed R2 upload for key: ${r2Key}`, uploadError);
                            r2FailCount++;
                        }
                    } else {
                        // ID 或 URL 缺失，计入失败或跳过
                        r2FailCount++; 
                    }
                });
                // 等待本页所有 R2 上传完成
                await Promise.allSettled(r2UploadPromises);
                console.log(`R2 upload attempts for page ${pageToProcess} finished. Success: ${r2SuccessCount}, Failed: ${r2FailCount}`);
                
                // 如果 R2 有部分失败，是否算作页面处理失败？取决于业务逻辑
                // 这里我们暂时认为只要没有抛出严重错误，就认为页面处理完成
                pageCompleted = pageToProcess; 

			} else {
				console.log(`No photos found on Unsplash page ${pageToProcess}. Considering page processed.`);
                // 如果某页返回空，也认为这一页“处理”完了，可以继续下一页
                pageCompleted = pageToProcess;
			}

            // 如果处理过程中没有抛出错误，则确认消息
            message.ack();
            console.log(`Message ID ${message.id} (Page ${pageToProcess}) acknowledged.`);

		} catch (error: any) {
            // 处理整个页面处理过程中的错误
			console.error(`Failed to process message ID ${message.id} (Page ${pageToProcess}):`, error);
            errorMessage = error.message || "Unknown error during queue processing";
            // 对于可重试的错误（比如网络超时、D1 临时错误），可以调用 message.retry()
            // 对于确定无法成功的错误（比如代码 bug、无效数据），应该调用 ack() 并记录错误
            // 这里简单处理：记录错误，然后 ack 掉消息，防止无限循环。
			message.ack(); // 确认消息，即使失败，防止卡住队列
		}

        // --- 4. 回调 API Worker 报告本页处理结果 ---
        // 无论成功或失败，都尝试报告给 DO，让 DO 决定下一步
        console.log(`Reporting status for page ${pageToProcess} back to API worker...`);
        const reportPayload = pageCompleted !== -1 
            ? { pageCompleted: pageCompleted } 
            : { error: `Failed to process page ${pageToProcess}: ${errorMessage}` };
            
        const reportUrl = `${env.API_WORKER_URL_SECRET}/report-sync-page`; // 使用 Secret 中的 URL
        
        // 使用 ctx.waitUntil 确保回调请求能发出，即使 queue handler 返回
        ctx.waitUntil(
            fetch(reportUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(reportPayload),
            })
            .then(async (res) => {
                if (!res.ok) {
                    console.error(`Failed to report page ${pageToProcess} status to API worker: ${res.status} ${res.statusText}`, await res.text());
                } else {
                    console.log(`Successfully reported page ${pageToProcess} status to API worker.`);
                }
            })
            .catch(err => {
                console.error(`Error sending report for page ${pageToProcess} to API worker:`, err);
            })
        );
	} // end for loop over messages
    console.log(`Finished processing queue batch.`);
}

// --- (确保这里没有 scheduled 导出) ---
