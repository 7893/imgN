// ~/imgN/sync-worker/src/handlers.ts
import { ExecutionContext, MessageBatch } from '@cloudflare/workers-types';
import { Env, UnsplashPhoto, QueueMessagePayload } from './types';
import { fetchLatestPhotos } from './unsplash';
import { upsertPhotoMetadataBatch } from './database';
import { uploadImageToR2 } from './storage';
import { getFolderNameFromTags } from './utils';

// --- CORS Helper Functions (保持不变) ---
const corsHeadersMap = { /* ... */ };
function addCorsHeaders(response: Response): void { /* ... */ Object.entries(corsHeadersMap).forEach(([key, value]) => { response.headers.set(key, value); }); }
function handleOptions(request: Request): Response { /* ... */ if (request.headers.get('Origin') !== null && request.headers.get('Access-Control-Request-Method') !== null && request.headers.get('Access-Control-Request-Headers') !== null) { return new Response(null, { headers: corsHeadersMap }); } else { return new Response(null, { headers: { Allow: 'GET, HEAD, OPTIONS' } }); } }

// --- Worker 事件处理程序 ---

// handleFetch (保持不变)
export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> { /* ... (状态页面逻辑) ... */ }

/**
 * 处理来自 Cloudflare Queue 的消息批次 (修改了回调 payload)
 */
export async function handleQueue(batch: MessageBatch<QueueMessagePayload>, env: Env, ctx: ExecutionContext): Promise<void> {
	console.log(`[${new Date().toISOString()}] Received queue batch with ${batch.messages.length} messages.`);

	for (const message of batch.messages) {
		const messageId = message.id;
		let pageToProcess: number | undefined;
		let processingSuccess = false;
		let errorMessageForReport: string | null = null;
		let photoCountThisPage = 0; // <-- 新增：记录本页获取到的图片数

		console.log(`Processing message ID: ${messageId}`);

		try {
			const payload = message.body;
			if (!payload || typeof payload.page !== 'number' || payload.page <= 0) { /* ... 无效消息处理 ... */ console.error(`Invalid payload for ${messageId}`); message.ack(); continue; }
			pageToProcess = payload.page;
			console.log(`Processing task for page ${pageToProcess}...`);

			// 1. 获取 Unsplash 数据
			const photos: UnsplashPhoto[] = await fetchLatestPhotos(env, pageToProcess, 30);
			photoCountThisPage = photos?.length ?? 0; // <--- 记录获取到的数量

			if (photoCountThisPage === 0) {
				console.log(`No photos found on Unsplash page ${pageToProcess}. Considering page processed.`);
				processingSuccess = true; // 认为是成功处理（该页已无内容）
			} else {
				console.log(`Workspaceed ${photoCountThisPage} photos from Unsplash page ${pageToProcess}.`);
				// 2. Upsert D1 元数据
				console.log(`Attempting D1 upsert for ${photoCountThisPage} photos...`);
				const validPhotosForDb = photos.filter(p => p && p.id);
				if (validPhotosForDb.length > 0) {
					const d1Results = await upsertPhotoMetadataBatch(env.DB, validPhotosForDb);
					console.log(`D1 upsert finished. Results count: ${d1Results?.length ?? 'N/A'}`);
				} else { console.log(`No valid photos with IDs for D1 upsert.`); }

				// 3. 分批上传 R2 图片 (带存在性检查)
				console.log(`Attempting R2 upload for ${photoCountThisPage} images...`);
				const r2BatchSize = 5;
				let r2FailCount = 0;
				for (let i = 0; i < photos.length; i += r2BatchSize) { /* ... (分批 R2 上传逻辑保持不变) ... */
					const photoBatch = photos.slice(i, i + r2BatchSize);
					console.log(` Processing R2 sub-batch ${Math.floor(i / r2BatchSize) + 1}...`);
					const batchPromises = photoBatch.map(async (photo) => { /* ... R2 head check and upload ... */ });
					await Promise.allSettled(batchPromises);
					console.log(`  R2 sub-batch ${Math.floor(i / r2BatchSize) + 1} settled.`);
				}
				console.log(`R2 uploads finished. Failures: ${r2FailCount}`);
				if (r2FailCount === 0) { processingSuccess = true; }
				else { processingSuccess = false; errorMessageForReport = `Page ${pageToProcess} processed with ${r2FailCount} R2 failures.`; }
			} // end else (photos found)

			// 确认消息
			if (processingSuccess) { message.ack(); console.log(`Message ${messageId} (Page ${pageToProcess}) acknowledged.`); }
			else { console.warn(`Processing page ${pageToProcess} completed with errors. Acking.`); message.ack(); }

		} catch (error: any) { /* ... (错误处理，ack 消息) ... */
			console.error(`Failed processing ${messageId} (Page ${pageToProcess}):`, error); errorMessageForReport = error.message; processingSuccess = false; console.error(`Acking failed message ${messageId}.`); message.ack();
		} finally {
			// --- 4. 回调 API Worker 报告本页处理结果 (修改 payload) ---
			if (pageToProcess !== undefined) {
				console.log(`Reporting status for page ${pageToProcess} (processed ${photoCountThisPage} photos)...`);

				// *** 修改：在成功回调中加入 photoCount ***
				const reportPayload = processingSuccess
					? { pageCompleted: pageToProcess, photoCount: photoCountThisPage } // <-- 加入 photoCount
					: { error: `Failed or partially failed... ${errorMessageForReport ?? '...'}` };

				const apiWorkerBinding = env.API_WORKER;
				if (!apiWorkerBinding) { console.error("FATAL: Service binding 'API_WORKER' missing!"); }
				else {
					const reportRequest = new Request(`http://api/report-sync-page`, {
						method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reportPayload)
					});

					console.log(`DEBUG: Attempting callback via binding with payload:`, JSON.stringify(reportPayload));

					ctx.waitUntil( // 发送回调
						apiWorkerBinding.fetch(reportRequest)
							.then(async (res) => { /* ... (处理回调响应日志) ... */ })
							.catch(err => { /* ... (处理回调网络错误) ... */ })
					);
				}
			}
		} // end finally block
	} // end for loop over messages
	console.log(`Finished processing queue batch.`);
} // end handleQueue