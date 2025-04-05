// ~/imgN/sync-worker/src/sync-logic.ts (修正 error 返回类型)
import { ExecutionContext } from '@cloudflare/workers-types'; // 导入 ExecutionContext
import { Env, UnsplashPhoto } from './types';
import { fetchLatestPhotos } from './unsplash';
import { upsertPhotoMetadataBatch } from './database';
import { uploadImageToR2 } from './storage';
import { getFolderNameFromTags } from './utils';

/**
 * 处理单个同步页面的核心逻辑。
 */
export async function processSyncPage(
	pageToProcess: number,
	env: Env,
	ctx: ExecutionContext // 需要传入 ctx 以便 R2 上传使用 waitUntil
): Promise<{ success: boolean; photoCount: number; error?: string }> // 返回类型明确 error 是 string | undefined
{
	let photoCountThisPage = 0;
	let errorMessage: string | null = null; // 内部可以用 null
	let allR2Successful = true;

	try {
		// ... (获取 photos, photoCountThisPage = ...) ...
		console.log(`[SyncLogic] Fetching page ${pageToProcess}...`);
		const photos: UnsplashPhoto[] = await fetchLatestPhotos(env, pageToProcess, 30);
		photoCountThisPage = photos?.length ?? 0;

		if (photoCountThisPage === 0) { /* ... */ return { success: true, photoCount: 0 }; }
		else {
			console.log(`[SyncLogic] Fetched ${photoCountThisPage} photos. Processing D1...`);
			// ... (D1 Upsert) ...
			const validPhotosForDb = photos.filter(p => p && p.id); if (validPhotosForDb.length > 0) { await upsertPhotoMetadataBatch(env.DB, validPhotosForDb); }

			// ... (准备 R2 上传 Promises) ...
			console.log(`[SyncLogic] Queuing R2 uploads for ${photoCountThisPage} images...`);
			let r2FailCount = 0;
			const r2UploadPromises = photos.map((photo) => { /* ... (构造 r2Key, head 检查, 调用 uploadImageToR2) ... */ });
			// --- 修改：将 R2 Promise 放入 waitUntil ---
			ctx.waitUntil(
				Promise.allSettled(r2UploadPromises).then(results => {
					const rejected = results.filter(r => r.status === 'rejected').length;
					console.log(`[SyncLogic Background] R2 uploads settled for page ${pageToProcess}. Rejected: ${rejected}`);
					// 注意：这里的失败计数发生在后台，无法直接影响函数的返回值
				})
			);
			// --- 结束修改 ---

			// 之前的失败计数逻辑 (r2FailCount) 只记录了 head 或同步调用时的错误
			// 为了简单，我们假设 D1 成功就认为处理基本成功，R2 错误会在日志体现
			if (r2FailCount > 0) {
				errorMessage = `Page ${pageToProcess} had ${r2FailCount} R2 pre-upload/check failures.`;
			}
			// 返回结果，将 error: null 转换为 undefined
			return { success: true, photoCount: photoCountThisPage, error: errorMessage ?? undefined };
		}
	} catch (error: any) {
		console.error(`[SyncLogic] Failed page ${pageToProcess}:`, error);
		// 返回结果，将 error: null 转换为 undefined
		return { success: false, photoCount: photoCountThisPage, error: (error.message || "Unknown error") ?? undefined };
	}
}