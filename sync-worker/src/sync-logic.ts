// /home/ubuntu/imgN/sync-worker/src/sync-logic.ts (完整代码)

import { ExecutionContext } from '@cloudflare/workers-types';
// 从本地 types.ts 导入 Env, UnsplashPhoto, 和 SyncPageResult 接口
import { Env, UnsplashPhoto, SyncPageResult } from './types';
// 导入辅助函数 - 确保这些文件存在且路径正确
import { fetchLatestPhotos } from './unsplash';
import { upsertPhotoMetadataBatch } from './database';
import { uploadImageToR2 } from './storage';
import { getFolderNameFromTags } from './utils';

/**
 * 处理单个同步页面的核心逻辑。
 * 从 Unsplash 拉取数据，存入 D1，并将图片上传到 R2 (后台)。
 * @param pageToProcess - 需要处理的 Unsplash 页码。
 * @param env - Worker 的环境绑定 (包含 DB, R2, Secrets, Fetcher 等)。
 * @param ctx - 执行上下文，用于 ctx.waitUntil。
 * @returns 一个 Promise，解析为 SyncPageResult 对象，包含处理结果。
 */
export async function processSyncPage(
	pageToProcess: number,
	env: Env, // Env 来自 ./types.ts, 应包含 DB, IMAGE_BUCKET, UNSPLASH_ACCESS_KEY
	ctx: ExecutionContext
): Promise<SyncPageResult> // 返回类型使用本地定义的 SyncPageResult
{
	let photoCountThisPage = 0;
	let errorMessage: string | null = null;
	// 注意：R2 上传是后台任务，此变量主要跟踪同步检查或准备阶段的 R2 错误
	let r2PreCheckFailCount = 0;

	try {
		// 1. 从 Unsplash 获取照片数据
		console.log(`[SyncLogic] Fetching Unsplash page ${pageToProcess}...`);
		// 确保 fetchLatestPhotos 使用了 env.UNSPLASH_ACCESS_KEY
		const photos: UnsplashPhoto[] = await fetchLatestPhotos(env, pageToProcess, 30); // 每页获取 30 张
		photoCountThisPage = photos?.length ?? 0;

		// 检查是否获取到照片
		if (photoCountThisPage === 0) {
			console.log(`[SyncLogic] Page ${pageToProcess} returned 0 photos. Assuming end of collection.`);
			// 如果没有照片，认为同步完成（对于此路径），返回成功和 0 计数
			return { success: true, photoCount: 0 };
		}

		console.log(`[SyncLogic] Fetched ${photoCountThisPage} photos for page ${pageToProcess}. Processing D1 upsert...`);

		// 2. 将元数据 Upsert 到 D1 数据库
		// 过滤掉没有有效 ID 的照片数据
		const validPhotosForDb = photos.filter(p => p && p.id);
		if (validPhotosForDb.length > 0) {
			// 确保 upsertPhotoMetadataBatch 使用了 env.DB
			await upsertPhotoMetadataBatch(env.DB, validPhotosForDb);
			console.log(`[SyncLogic] D1 upsert completed for ${validPhotosForDb.length} valid photos.`);
		} else if (photoCountThisPage > 0) {
			// 如果原始列表有照片但过滤后没有，记录警告
			console.warn(`[SyncLogic] Page ${pageToProcess} had ${photoCountThisPage} photos, but none with valid IDs for DB upsert.`);
		}

		// 3. 准备并将图片上传到 R2 (放入 waitUntil 后台执行)
		console.log(`[SyncLogic] Queuing R2 uploads in background for up to ${photoCountThisPage} images (Page ${pageToProcess})...`);

		const r2UploadPromises = photos
			// 确保照片有 ID 和有效的原始 URL 用于下载
			.filter(photo => photo && photo.id && photo.urls?.raw)
			.map((photo) => {
				// 使用非空断言，因为 filter 保证了这些值存在
				const photoId = photo.id!;
				const imageUrl = photo.urls!.raw;
				// 使用工具函数确定 R2 存储文件夹
				const folderName = getFolderNameFromTags(photo.tags);
				// 构造 R2 对象键 (路径 + 文件名)
				const r2Key = `${folderName}/${photoId}.jpg`; // 假设都存为 jpg

				// 返回一个立即执行的异步函数 (IIFE) 以便放入 waitUntil
				return (async () => {
					try {
						// 可以在这里添加 R2 head 请求来检查对象是否已存在，以避免重复上传
						// const existingObject = await env.IMAGE_BUCKET.head(r2Key);
						// if (existingObject) {
						//     console.log(`  [R2 Skip] Object already exists: ${r2Key}`);
						//     return; // 跳过上传
						// }

						// 确保 uploadImageToR2 使用了 env.IMAGE_BUCKET
						await uploadImageToR2(env.IMAGE_BUCKET, r2Key, imageUrl);
						// 可以在这里添加日志记录成功的上传
						// console.log(`  [R2 Success] Uploaded: ${r2Key}`);
					} catch (r2Error: unknown) {
						console.error(`  [R2 Upload Error] Failed background R2 upload for key ${r2Key} (Page ${pageToProcess}):`, r2Error);
						// R2 后台上传失败通常不影响 processSyncPage 的主要成功状态，只记录错误
						// 可以考虑将失败信息写入 KV 或 Queue 进行后续处理
					}
				})();
			});

		// 使用 ctx.waitUntil 执行 R2 上传，不阻塞当前函数的返回
		if (r2UploadPromises.length > 0) {
			console.log(`[SyncLogic] Adding ${r2UploadPromises.length} R2 upload tasks to waitUntil for page ${pageToProcess}.`);
			ctx.waitUntil(
				Promise.allSettled(r2UploadPromises).then(results => {
					// 可以在这里统计后台任务的最终成功/失败数量
					const failedCount = results.filter(r => r.status === 'rejected').length;
					const successCount = results.length - failedCount;
					console.log(`[SyncLogic Background] R2 uploads settled for page ${pageToProcess}. Success: ${successCount}, Failed: ${failedCount}`);
				})
			);
		}

		// 4. 返回处理结果
		// 如果在准备 R2 任务时（同步阶段）检测到错误，记录到 errorMessage
		if (r2PreCheckFailCount > 0) {
			errorMessage = `Page ${pageToProcess} had ${r2PreCheckFailCount} R2 pre-upload/check failures.`;
			console.warn(`[SyncLogic] ${errorMessage}`);
			// 根据业务逻辑决定这种情况是否算作页面处理失败
			// 当前实现：仍然报告 success: true，但包含错误信息
		}

		console.log(`[SyncLogic] Finished synchronous processing for page ${pageToProcess}. Reporting success (R2 uploads continue in background).`);
		// D1 操作（理论上）已完成，返回成功状态和处理的照片数
		return {
			success: true,
			photoCount: photoCountThisPage, // 返回的是从 API 获取到的数量
			error: errorMessage ?? undefined // 如果同步检查有错，则附带信息
		};

	} catch (error: unknown) { // 使用 unknown 类型捕获错误更安全
		console.error(`[SyncLogic] CRITICAL Error processing page ${pageToProcess}:`, error);
		// 发生意外错误，返回失败状态
		return {
			success: false,
			photoCount: photoCountThisPage, // 仍然报告尝试处理的数量
			// 提供错误信息
			error: (error instanceof Error ? error.message : String(error)) || "Unknown sync logic error"
		};
	}
}