// ~/imgN/sync-worker/src/handlers.ts
import { ExecutionContext, MessageBatch } from '@cloudflare/workers-types';
// 确保从正确的路径导入类型和辅助函数
import { Env, UnsplashPhoto, QueueMessagePayload } from './types'; 
import { fetchLatestPhotos } from './unsplash';
import { upsertPhotoMetadataBatch } from './database';
import { uploadImageToR2 } from './storage';
import { getFolderNameFromTags } from './utils'; // 假设辅助函数在 utils.ts

// --- CORS Helper Functions ---
const corsHeadersMap = {
	'Access-Control-Allow-Origin': '*', // 生产环境建议替换为你的 Pages 域名
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', // Sync worker fetch 只需 GET/OPTIONS
	'Access-Control-Allow-Headers': 'Content-Type',
	'Access-Control-Max-Age': '86400', 
};

function addCorsHeaders(response: Response): void {
    // 直接修改传入 Response 的 Headers
    Object.entries(corsHeadersMap).forEach(([key, value]) => { 
        response.headers.set(key, value); 
    });
}

function handleOptions(request: Request): Response { 
	if (request.headers.get('Origin') !== null &&
		request.headers.get('Access-Control-Request-Method') !== null &&
		request.headers.get('Access-Control-Request-Headers') !== null) {
		// 处理 CORS 预检请求
		return new Response(null, { headers: corsHeadersMap });
	} else { 
        // 处理标准 OPTIONS 请求
        return new Response(null, { headers: { Allow: 'GET, HEAD, OPTIONS' } }); 
    } 
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
		addCorsHeaders(response); 
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

	// 依次处理批次中的每条消息
	for (const message of batch.messages) {
		const messageId = message.id;
		let pageToProcess: number | undefined;
        let processingSuccess = false; // 标记此消息是否成功处理 (所有步骤基本完成)
        let errorMessageForReport: string | null = null; // 记录处理过程中的主要错误信息

		console.log(`Processing message ID: ${messageId}`);
		
		try {
			const payload = message.body; // message.body 已是解析好的对象
			// 验证消息载荷
			if (!payload || typeof payload.page !== 'number' || payload.page <= 0) {
				console.error(`Invalid message payload received for ID ${messageId}:`, payload);
				message.ack(); // 确认无效消息，不再重试
				continue; // 处理下一条消息
			}
			pageToProcess = payload.page; 
			console.log(`Processing task for page ${pageToProcess}...`);

			// 1. 获取 Unsplash 数据 (每次 30 张, oldest)
			const photos: UnsplashPhoto[] = await fetchLatestPhotos(env, pageToProcess, 30);

			if (!photos || photos.length === 0) {
				console.log(`No photos found on Unsplash page ${pageToProcess}. Considering page processed.`);
                processingSuccess = true; // 认为是成功处理（该页已无内容）
			} else {
				// 2. Upsert D1 元数据 (需要 await)
				console.log(`Attempting D1 upsert for ${photos.length} photos on page ${pageToProcess}...`);
				const validPhotosForDb = photos.filter(p => p && p.id);
				if (validPhotosForDb.length > 0) {
					// 等待 D1 操作完成，如果失败会抛出错误被外层 catch 捕获
					const d1Results = await upsertPhotoMetadataBatch(env.DB, validPhotosForDb); 
					console.log(`D1 upsert finished for page ${pageToProcess}. Results count: ${d1Results?.length ?? 'N/A'}`);
				} else {
					console.log(`No valid photos with IDs found for D1 upsert on page ${pageToProcess}.`);
				}

				// 3. 分批上传 R2 图片 (带存在性检查)
				console.log(`Attempting R2 upload for ${photos.length} images on page ${pageToProcess}...`);
                const r2BatchSize = 5; // R2 并发批次大小
                let r2FailCount = 0; 
				for (let i = 0; i < photos.length; i += r2BatchSize) {
					const photoBatch = photos.slice(i, i + r2BatchSize); 
					console.log(` Processing R2 upload sub-batch ${Math.floor(i / r2BatchSize) + 1} (size: ${photoBatch.length})...`);
					
					// 创建当前批次的上传 Promises
					const batchPromises = photoBatch.map(async (photo) => { 
						const photoId = photo?.id;
						// 使用原始图片 URL
						const imageUrlToDownload = photo?.urls?.raw ?? photo?.urls?.regular; 

						if (photoId && imageUrlToDownload) {
							// 从 Tag 获取文件夹名
							const folderName = getFolderNameFromTags(photo.tags);
							// 构造 R2 Key
							const r2Key = `${folderName}/${photoId}`;
							try {
								// 检查 R2 是否已存在
								const existingObject = await env.IMAGE_BUCKET.head(r2Key);
								if (existingObject !== null) {
									console.log(`  Skipping R2 upload for key: ${r2Key} (already exists).`);
								} else {
									console.log(`  Starting R2 upload for key: ${r2Key}`);
									// 执行上传，如果失败 uploadImageToR2 会抛出错误
									await uploadImageToR2(env.IMAGE_BUCKET, r2Key, imageUrlToDownload);
								}
							} catch (uploadError) {
								// 捕获 uploadImageToR2 抛出的错误
								console.error(`  Failed R2 processing for key: ${r2Key}`, uploadError);
                                r2FailCount++; 
							}
						} else {
                             if (!photoId) console.warn("  Skipping R2 upload due to missing photo ID.");
                             if (!imageUrlToDownload) console.warn(`  Skipping R2 upload for ${photoId} due to missing image URL.`);
                             r2FailCount++; // 视为失败
						}
					});
					// 等待当前小批次的所有上传尝试完成
					await Promise.allSettled(batchPromises); 
                    console.log(`  R2 upload sub-batch ${Math.floor(i / r2BatchSize) + 1} settled.`);
				} // end for loop for R2 batches

                 console.log(`R2 upload attempts for page ${pageToProcess} finished. Failures recorded: ${r2FailCount}`);
                 // 如果 R2 处理有任何失败，则将整个页面的处理标记为不完全成功
                 if (r2FailCount === 0) {
                     processingSuccess = true; 
                 } else {
                     processingSuccess = false; 
                     errorMessageForReport = `Page ${pageToProcess} processed with ${r2FailCount} R2 upload failures.`;
                 }
			} // end else (photos found)

            // 确认消息: 只有在整个 try 块没有抛出错误时才执行 ack (或者根据需要调整逻辑)
            message.ack();
            console.log(`Message ID ${messageId} (Page ${pageToProcess}) acknowledged.`);

		} catch (error: any) {
            // 捕获处理过程中的主要错误 (例如 D1 错误, Unsplash API 错误)
			console.error(`Failed to process message ID ${messageId} (Page ${pageToProcess}):`, error);
            errorMessageForReport = error.message || "Unknown error during queue processing";
            processingSuccess = false; // 标记处理失败
            
            // 决定是否重试 (可以根据错误类型决定)
            // 简单起见，暂时不重试，直接 ack 并报告错误
            console.error(`Acknowledging failed message ID ${messageId} to prevent retry loop.`);
			message.ack(); 
		} finally {
            // --- 4. 回调 API Worker 报告本页处理结果 ---
            // 确保 pageToProcess 有值再进行回调
            if (pageToProcess !== undefined) {
                console.log(`Reporting status for page ${pageToProcess} back to API worker...`);
                // 构造回调载荷：成功时报告页码，失败时报告错误
                const reportPayload = processingSuccess 
                    ? { pageCompleted: pageToProcess } 
                    : { error: `Failed or partially failed to process page ${pageToProcess}: ${errorMessageForReport ?? 'R2 upload failures or other error'}` };
                    
                // 从环境变量获取 API Worker URL
                const apiWorkerUrl = env.API_WORKER_BASE_URL; 
                if (!apiWorkerUrl) {
                     console.error("FATAL: API_WORKER_BASE_URL var is not configured in wrangler.jsonc! Cannot report back.");
                } else {
                    const reportUrl = `${apiWorkerUrl}/report-sync-page`; // 拼接完整回调 URL
                    
                    // 打印将要访问的 URL (用于调试)
                    console.log(`DEBUG: Attempting callback fetch to URL: [${reportUrl}]`); 
                    
                    // 使用 ctx.waitUntil 确保回调请求能发出，不阻塞当前函数返回
                    ctx.waitUntil(
                        fetch(reportUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(reportPayload), // 发送 JSON 载荷
                        })
                        .then(async (res) => { // 使用 async 以便读取 res.text()
                            if (!res.ok) {
                                // 如果回调失败，打印详细错误
                                console.error(`[Callback Error] Failed to report page ${pageToProcess} status to API worker: ${res.status} ${res.statusText}`, await res.text());
                            } else {
                                console.log(`[Callback Success] Successfully reported page ${pageToProcess} status to API worker.`);
                            }
                        })
                        .catch(err => {
                            // 网络层面的错误
                            console.error(`[Callback Network Error] Error sending report for page ${pageToProcess} to API worker:`, err);
                        })
                    );
                } // end if apiWorkerUrl
            } // end if pageToProcess !== undefined
        } // end finally block
	} // end for loop over messages

    console.log(`Finished processing queue batch of ${batch.messages.length} messages.`);
} // <--- handleQueue 函数结束
