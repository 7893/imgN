// ~/imgN/sync-worker/src/sync-logic.ts
import { Env, UnsplashPhoto } from './types';
import { fetchLatestPhotos } from './unsplash';
import { upsertPhotoMetadataBatch } from './database';
import { uploadImageToR2 } from './storage';
import { getFolderNameFromTags } from './utils'; // 假设在 utils.ts

/**
 * 处理单个同步页面的核心逻辑。
 * @param pageToProcess 要处理的 Unsplash 页码
 * @param env Worker 环境和绑定
 * @param ctx 执行上下文 (用于 R2 的 waitUntil)
 * @returns Promise 对象，包含处理结果 { success: boolean, photoCount: number, error?: string }
 */
export async function processSyncPage(
	pageToProcess: number, 
	env: Env, 
	ctx: ExecutionContext
): Promise<{ success: boolean; photoCount: number; error?: string }> 
{
	let photoCountThisPage = 0;
    let errorMessage: string | null = null;
    let allR2Successful = true; // 标记 R2 上传是否全部成功（或跳过）

	try {
		// 1. 获取 Unsplash 数据
		console.log(`[SyncLogic] Fetching Unsplash page ${pageToProcess}...`);
		const photos: UnsplashPhoto[] = await fetchLatestPhotos(env, pageToProcess, 30);
		photoCountThisPage = photos?.length ?? 0;

		if (photoCountThisPage === 0) {
			console.log(`[SyncLogic] No photos found on Unsplash page ${pageToProcess}.`);
			return { success: true, photoCount: 0 }; // 认为处理成功，但没有图片
		} else {
			console.log(`[SyncLogic] Fetched ${photoCountThisPage} photos. Processing D1 upsert...`);
			// 2. Upsert D1 元数据
			const validPhotosForDb = photos.filter(p => p && p.id);
			if (validPhotosForDb.length > 0) {
				// 注意：这里不再需要 waitUntil，因为 queue handler 会等待这个函数完成
				const d1Results = await upsertPhotoMetadataBatch(env.DB, validPhotosForDb); 
				console.log(`[SyncLogic] D1 upsert finished. Results: ${d1Results?.length ?? 'N/A'}`);
			} else {
				console.log(`[SyncLogic] No valid photos with IDs for D1 upsert.`);
			}

			// 3. 分批上传 R2 图片 (带存在性检查)
			console.log(`[SyncLogic] Processing R2 upload for ${photoCountThisPage} images...`);
            const r2BatchSize = 5; 
            let r2FailCount = 0; 
			for (let i = 0; i < photos.length; i += r2BatchSize) {
				const photoBatch = photos.slice(i, i + r2BatchSize); 
				console.log(`  Processing R2 sub-batch ${Math.floor(i / r2BatchSize) + 1}...`);
				const batchPromises = photoBatch.map(async (photo) => { 
					const photoId = photo?.id;
					const imageUrlToDownload = photo?.urls?.raw ?? photo?.urls?.regular; 
					if (photoId && imageUrlToDownload) {
						const folderName = getFolderNameFromTags(photo.tags);
						const r2Key = `${folderName}/${photoId}`;
						try {
							const existingObject = await env.IMAGE_BUCKET.head(r2Key);
							if (existingObject === null) {
								console.log(`  Starting R2 upload: ${r2Key}`);
                                // 重要：将 R2 上传包裹在 waitUntil 中，允许它们在后台完成
								ctx.waitUntil(uploadImageToR2(env.IMAGE_BUCKET, r2Key, imageUrlToDownload)
                                    .catch(err => {
                                         console.error(`  Background R2 upload failed for ${r2Key}:`, err);
                                         // 注意：这里的失败不会阻塞 processSyncPage 的返回
                                         // 可能需要更复杂的机制来跟踪后台失败
                                    })
                                );
							} else { console.log(`  Skipping R2 (exists): ${r2Key}`); }
						} catch (headOrOtherError) { 
                            // head 失败也算 R2 处理失败
                            console.error(`  Failed R2 head/processing for key: ${r2Key}`, headOrOtherError); 
                            r2FailCount++; 
                        }
					} else { r2FailCount++; }
				});
				// 不再等待小批次，让 waitUntil 处理后台上传
				// await Promise.allSettled(batchPromises); 
                // console.log(`  R2 sub-batch ${Math.floor(i / r2BatchSize) + 1} queued.`);
                // 等待批处理promise创建完成即可，实际上传由waitUntil处理
                 await Promise.all(batchPromises.map(p => p.catch(e => null))); // 等待map循环完成，忽略错误
			} // end for loop for R2 batches
             console.log(`[SyncLogic] R2 uploads queued/skipped. Failures during check/queue: ${r2FailCount}`);
             // 只要没有抛出严重错误，就认为本函数成功启动了 D1 和 R2 操作
             if (r2FailCount > 0) {
                 errorMessage = `Page ${pageToProcess} processed with ${r2FailCount} R2 pre-upload failures/skips.`;
             }
             // 即使 R2 有失败，也认为元数据处理成功了，返回 success: true
             return { success: true, photoCount: photoCountThisPage, error: errorMessage }; 
		} // end else (photos found)

	} catch (error: any) {
		// 捕获处理过程中的主要错误 (例如 D1 错误, Unsplash API 错误)
		console.error(`[SyncLogic] Failed processing page ${pageToProcess}:`, error);
        return { success: false, photoCount: photoCountThisPage, error: error.message || "Unknown error in processSyncPage" };
	}
}
