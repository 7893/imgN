// ~/imgN/sync-worker/src/handlers.ts (包含测试完成逻辑的临时修改)
import { ExecutionContext, MessageBatch } from '@cloudflare/workers-types';
import { Env, UnsplashPhoto, QueueMessagePayload } from './types';
import { fetchLatestPhotos } from './unsplash';
import { upsertPhotoMetadataBatch } from './database';
import { uploadImageToR2 } from './storage';
import { getFolderNameFromTags } from './utils'; // 确保 utils.ts 文件存在且函数已导出

// --- CORS Helper Functions (保持不变) ---
const corsHeadersMap = { /* ... */ };
function addCorsHeaders(response: Response): void { /* ... */ Object.entries(corsHeadersMap).forEach(([key, value]) => { response.headers.set(key, value); }); }
function handleOptions(request: Request): Response { /* ... */ if (request.headers.get('Origin') !== null && request.headers.get('Access-Control-Request-Method') !== null && request.headers.get('Access-Control-Request-Headers') !== null) { return new Response(null, { headers: corsHeadersMap }); } else { return new Response(null, { headers: { Allow: 'GET, HEAD, OPTIONS' } }); } }

// --- Worker 事件处理程序 ---

// handleFetch (状态页面逻辑保持不变)
export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> { /* ... */ }

/**
 * 处理来自 Cloudflare Queue 的消息批次 (包含临时修改以测试完成逻辑)
 */
export async function handleQueue(batch: MessageBatch<QueueMessagePayload>, env: Env, ctx: ExecutionContext): Promise<void> {
	console.log(`[${new Date().toISOString()}] Received queue batch with ${batch.messages.length} messages.`);

	for (const message of batch.messages) {
		const messageId = message.id;
		let pageToProcess: number | undefined;
        let processingSuccess = false; 
        let errorMessageForReport: string | null = null;
        let photoCountThisPage = 0; // 初始化本页获取到的图片数

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
                processingSuccess = true; 
			} else {
                console.log(`Workspaceed ${photoCountThisPage} photos from Unsplash page ${pageToProcess}.`);
				// 2. Upsert D1 元数据
				console.log(`Attempting D1 upsert for ${photoCountThisPage} photos...`);
				const validPhotosForDb = photos.filter(p => p && p.id);
				if (validPhotosForDb.length > 0) {
					await upsertPhotoMetadataBatch(env.DB, validPhotosForDb); 
					console.log(`D1 upsert finished.`);
				} else { console.log(`No valid photos for D1 upsert.`); }

				// 3. 分批上传 R2 图片 (带存在性检查)
				console.log(`Attempting R2 upload for ${photoCountThisPage} images...`);
                const r2BatchSize = 5; 
                let r2FailCount = 0; 
				for (let i = 0; i < photos.length; i += r2BatchSize) { 
                    const photoBatch = photos.slice(i, i + r2BatchSize); 
					console.log(` Processing R2 sub-batch ${Math.floor(i / r2BatchSize) + 1}...`);
					const batchPromises = photoBatch.map(async (photo) => { /* ... R2 head check, uploadImageToR2 call, error handling ... */ });
					await Promise.allSettled(batchPromises); 
                    console.log(`  R2 sub-batch ${Math.floor(i / r2BatchSize) + 1} settled.`);
                } 
                 console.log(`R2 uploads finished. Failures: ${r2FailCount}`);
                 if (r2FailCount === 0) { processingSuccess = true; } 
                 else { processingSuccess = false; errorMessageForReport = `Page ${pageToProcess} with ${r2FailCount} R2 failures.`; }
			} // end else (photos found)

            // 确认消息
            if (processingSuccess) { message.ack(); console.log(`Message ${messageId} (Page ${pageToProcess}) acknowledged.`); } 
            else { console.warn(`Processing page ${pageToProcess} completed with errors. Acking.`); message.ack(); }

		} catch (error: any) { /* ... (错误处理，ack 消息) ... */ 
            console.error(`Failed processing ${messageId} (Page ${pageToProcess}):`, error); errorMessageForReport = error.message; processingSuccess = false; console.error(`Acking failed message ${messageId}.`); message.ack(); 
        } finally {
            // --- 4. 回调 API Worker 报告本页处理结果 (包含临时修改) ---
            if (pageToProcess !== undefined) {
                console.log(`Reporting status for page ${pageToProcess}...`);
                
                let reportPayload: object; // 最终发送的载荷

                // ========== 临时调试代码 开始 ==========
                // 强制在处理完第一页后，发送 photoCount 为 0 的报告
                if (pageToProcess === 1) { 
                    console.warn(`[DEBUG] >>> Forcing photoCount=0 for page 1 callback to test completion logic.`);
                    reportPayload = { pageCompleted: pageToProcess, photoCount: 0 }; 
                    processingSuccess = true; // 强制认为处理成功，以便DO正确接收完成信号
                    errorMessageForReport = null; // 清除错误信息
                } else { 
                    // 对于其他页面（如果能跑到的话），使用正常逻辑
                    reportPayload = processingSuccess 
                        ? { pageCompleted: pageToProcess, photoCount: photoCountThisPage } 
                        : { error: `Failed or partially failed... ${errorMessageForReport ?? '...'}` };
                }
                // ========== 临时调试代码 结束 ==========
                    
                const apiWorkerBinding = env.API_WORKER; 
                if (!apiWorkerBinding) { console.error("FATAL: Service binding 'API_WORKER' missing!"); } 
                else {
                    const reportRequest = new Request(`http://api/report-sync-page`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reportPayload), });
                    console.log(`DEBUG: Attempting callback via binding with payload:`, JSON.stringify(reportPayload)); 
                    ctx.waitUntil( // 发送回调
                        apiWorkerBinding.fetch(reportRequest).then(async (res) => { /* ... (处理回调响应日志) ... */ }).catch(err => { /* ... (处理回调网络错误) ... */ })
                    );
                } 
            } 
        } // end finally block
	} // end for loop over messages

    console.log(`Finished processing queue batch.`);
} // end handleQueue
