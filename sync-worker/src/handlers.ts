// ~/imgN/sync-worker/src/handlers.ts
import { ExecutionContext, MessageBatch } from '@cloudflare/workers-types';
import { Env, UnsplashPhoto, QueueMessagePayload } from './types';
import { fetchLatestPhotos } from './unsplash';
import { upsertPhotoMetadataBatch } from './database';
import { uploadImageToR2 } from './storage';
import { getFolderNameFromTags } from './utils'; // 确保 utils.ts 文件存在且函数已导出

// --- CORS Helper Functions (保持不变) ---
const corsHeadersMap = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
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
		return new Response(null, { headers: { Allow: 'GET, HEAD, OPTIONS' } });
	}
}


// --- Worker 事件处理程序 ---

/**
 * 处理 HTTP Fetch 请求 (状态页面 - 保持不变)
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
 * 处理来自 Cloudflare Queue 的消息批次 (修改了回调部分)
 */
export async function handleQueue(batch: MessageBatch<QueueMessagePayload>, env: Env, ctx: ExecutionContext): Promise<void> {
	console.log(`[${new Date().toISOString()}] Received queue batch with ${batch.messages.length} messages.`);

	for (const message of batch.messages) {
		const messageId = message.id;
		let pageToProcess: number | undefined;
		let processingSuccess = false;
		let errorMessageForReport: string | null = null;

		console.log(`Processing message ID: ${messageId}`);

		try {
			const payload = message.body;
			if (!payload || typeof payload.page !== 'number' || payload.page <= 0) {
				console.error(`Invalid message payload received for ID ${messageId}:`, payload);
				message.ack();
				continue;
			}
			pageToProcess = payload.page;
			console.log(`Processing task for page ${pageToProcess}...`);

			// 1. 获取 Unsplash 数据
			const photos: UnsplashPhoto[] = await fetchLatestPhotos(env, pageToProcess, 30);

			if (!photos || photos.length === 0) {
				console.log(`No photos found on Unsplash page ${pageToProcess}. Considering page processed.`);
				processingSuccess = true;
			} else {
				// 2. Upsert D1 元数据
				console.log(`Attempting D1 upsert for ${photos.length} photos on page ${pageToProcess}...`);
				const validPhotosForDb = photos.filter(p => p && p.id);
				if (validPhotosForDb.length > 0) {
					const d1Results = await upsertPhotoMetadataBatch(env.DB, validPhotosForDb);
					console.log(`D1 upsert finished for page ${pageToProcess}. Results count: ${d1Results?.length ?? 'N/A'}`);
				} else {
					console.log(`No valid photos with IDs found for D1 upsert on page ${pageToProcess}.`);
				}

				// 3. 分批上传 R2 图片 (带存在性检查)
				console.log(`Attempting R2 upload for ${photos.length} images on page ${pageToProcess}...`);
				const r2BatchSize = 5;
				let r2FailCount = 0;
				for (let i = 0; i < photos.length; i += r2BatchSize) {
					const photoBatch = photos.slice(i, i + r2BatchSize);
					console.log(` Processing R2 upload sub-batch ${Math.floor(i / r2BatchSize) + 1} (size: ${photoBatch.length})...`);
					const batchPromises = photoBatch.map(async (photo) => {
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
								}
							} catch (uploadError) {
								console.error(`  Failed R2 processing for key: ${r2Key}`, uploadError);
								r2FailCount++;
							}
						} else {
							if (!photoId) console.warn("  Skipping R2 upload due to missing photo ID.");
							if (!imageUrlToDownload) console.warn(`  Skipping R2 upload for ${photoId} due to missing image URL.`);
							r2FailCount++;
						}
					});
					await Promise.allSettled(batchPromises);
					console.log(`  R2 upload sub-batch ${Math.floor(i / r2BatchSize) + 1} settled.`);
				}
				console.log(`R2 upload attempts for page ${pageToProcess} finished. Failures recorded: ${r2FailCount}`);
				if (r2FailCount === 0) {
					processingSuccess = true;
				} else {
					processingSuccess = false;
					errorMessageForReport = `Page ${pageToProcess} processed with ${r2FailCount} R2 upload failures.`;
				}
			} // end else (photos found)

			// 确认消息
			if (processingSuccess) {
				message.ack();
				console.log(`Message ID ${messageId} (Page ${pageToProcess}) acknowledged.`);
			} else {
				console.warn(`Processing for page ${pageToProcess} completed with errors. Acknowledging message.`);
				message.ack();
			}

		} catch (error: any) {
			console.error(`Failed to process message ID ${messageId} (Page ${pageToProcess}):`, error);
			errorMessageForReport = error.message || "Unknown error during queue processing";
			processingSuccess = false;
			console.error(`Acknowledging failed message ID ${messageId} to prevent retry loop.`);
			message.ack();
		} finally {
			// --- 4. 回调 API Worker (使用 Service Binding) ---
			if (pageToProcess !== undefined) {
				console.log(`Reporting status for page ${pageToProcess} back to API worker via Service Binding...`);
				const reportPayload = processingSuccess
					? { pageCompleted: pageToProcess }
					: { error: `Failed or partially failed to process page ${pageToProcess}: ${errorMessageForReport ?? 'R2 upload failures or other error'}` };

				// *** 使用 Service Binding 发起请求 ***
				const apiWorkerBinding = env.API_WORKER; // <-- 获取绑定对象
				if (!apiWorkerBinding) {
					console.error("FATAL: Service binding 'API_WORKER' is not configured or available!");
				} else {
					// 构造一个指向目标内部路径的 Request 对象
					// URL 主机名随意写 (例如 "http://api")，但路径 /report-sync-page 必须匹配 api-worker 的期望
					const reportRequest = new Request(`http://api/report-sync-page`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(reportPayload),
					});

					// 不再需要打印公共 URL 的 Debug 日志了
					// console.log(`DEBUG: Attempting callback fetch to URL: [...]`); 

					// 使用绑定的 fetch 方法调用目标 Worker
					ctx.waitUntil(
						apiWorkerBinding.fetch(reportRequest) // <--- 使用绑定的 fetch
							.then(async (res) => {
								if (!res.ok) {
									console.error(`[Callback Error via Binding] Failed to report page ${pageToProcess} status: ${res.status} ${res.statusText}`, await res.text());
								} else {
									console.log(`[Callback Success via Binding] Successfully reported page ${pageToProcess} status.`);
									// 可以在这里根据 api-worker 返回的内容（例如 DO 返回的 nextPageQueued）决定是否需要进一步操作
								}
							})
							.catch(err => {
								console.error(`[Callback Network Error via Binding] Error sending report for page ${pageToProcess}:`, err);
							})
					);
				} // end if apiWorkerBinding
			} // end if pageToProcess !== undefined
		} // end finally block
	} // end for loop over messages

	console.log(`Finished processing queue batch of ${batch.messages.length} messages.`);
} // <--- handleQueue 函数结束