// ~/imgN/sync-worker/src/handlers.ts (修改 R2 下载 URL 优先级)
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
export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> { /* ... */ }

// handleQueue (修改 R2 下载 URL 选择)
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
			if (!payload || typeof payload.page !== 'number' || payload.page <= 0) { /* ... 无效消息处理 ... */ message.ack(); continue; }
			pageToProcess = payload.page;
			console.log(`Processing task for page ${pageToProcess}...`);

			// 1. 获取 Unsplash 数据 (保持不变)
			const photos: UnsplashPhoto[] = await fetchLatestPhotos(env, pageToProcess, 30);

			if (!photos || photos.length === 0) { /* ... 空数据处理 ... */ processingSuccess = true; }
			else {
				// 2. Upsert D1 元数据 (保持不变)
				console.log(`Attempting D1 upsert for ${photos.length} photos...`);
				const validPhotosForDb = photos.filter(p => p && p.id);
				if (validPhotosForDb.length > 0) { await upsertPhotoMetadataBatch(env.DB, validPhotosForDb); console.log(`D1 upsert finished...`); }
				else { console.log(`No valid photos for D1 upsert.`); }

				// 3. 分批上传 R2 图片 (修改 URL 选择)
				console.log(`Attempting R2 upload for ${photos.length} images...`);
				const r2BatchSize = 5;
				let r2FailCount = 0;
				for (let i = 0; i < photos.length; i += r2BatchSize) {
					const photoBatch = photos.slice(i, i + r2BatchSize);
					console.log(` Processing R2 upload sub-batch ${Math.floor(i / r2BatchSize) + 1}...`);
					const batchPromises = photoBatch.map(async (photo) => {
						const photoId = photo?.id;

						// *** 修改：优先下载 small，然后 regular，最后 raw ***
						const imageUrlToDownload = photo?.urls?.small ?? photo?.urls?.regular ?? photo?.urls?.raw;

						if (photoId && imageUrlToDownload) {
							const folderName = getFolderNameFromTags(photo.tags);
							const r2Key = `${folderName}/${photoId}`;
							try {
								const existingObject = await env.IMAGE_BUCKET.head(r2Key);
								if (existingObject !== null) { console.log(`  Skipping R2 upload (exists): ${r2Key}`); }
								else { console.log(`  Starting R2 upload: ${r2Key}`); await uploadImageToR2(env.IMAGE_BUCKET, r2Key, imageUrlToDownload); }
							} catch (uploadError) { console.error(`  Failed R2: ${r2Key}`, uploadError); r2FailCount++; }
						} else { /* ... 跳过日志 ... */ r2FailCount++; }
					});
					await Promise.allSettled(batchPromises);
					console.log(`  R2 sub-batch ${Math.floor(i / r2BatchSize) + 1} settled.`);
				}
				console.log(`R2 uploads finished. Failures: ${r2FailCount}`);
				if (r2FailCount === 0) { processingSuccess = true; }
				else { processingSuccess = false; errorMessageForReport = `Page ${pageToProcess} with ${r2FailCount} R2 failures.`; }
			} // end else (photos found)

			// 确认消息 (保持不变)
			if (processingSuccess) { message.ack(); console.log(`Message ${messageId} ack.`); }
			else { console.warn(`Processing page ${pageToProcess} completed with errors. Acking.`); message.ack(); }

		} catch (error: any) { // ... (错误处理，ack 消息) ...
			console.error(`Failed processing ${messageId} (Page ${pageToProcess}):`, error); errorMessageForReport = error.message; processingSuccess = false; console.error(`Acking failed message ${messageId}.`); message.ack();
		} finally { // --- 回调 API Worker (保持不变) ---
			if (pageToProcess !== undefined) {
				console.log(`Reporting page ${pageToProcess}...`);
				const reportPayload = processingSuccess ? { pageCompleted: pageToProcess } : { error: `Failed... ${errorMessageForReport ?? '...'}` };
				const apiWorkerBinding = env.API_WORKER;
				if (!apiWorkerBinding) { console.error("FATAL: Service binding 'API_WORKER' missing!"); }
				else {
					const reportRequest = new Request(`http://api/report-sync-page`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reportPayload), });
					console.log(`DEBUG: Attempting callback via binding to /report-sync-page`);
					ctx.waitUntil(apiWorkerBinding.fetch(reportRequest).then(async (res) => { /* ... 日志 ... */ }).catch(err => { /* ... 日志 ... */ }));
				}
			}
		} // end finally
	} // end for loop
	console.log(`Finished queue batch.`);
} // end handleQueue