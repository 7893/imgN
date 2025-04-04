// src/storage.ts
import { Env } from './types'; // 确保导入 Env 或在此定义

/**
 * 从指定 URL 下载图片并上传到 R2 Bucket。
 * @param bucket R2Bucket 实例 (来自 env.IMAGE_BUCKET)
 * @param r2Key 要在 R2 中使用的完整对象键 (例如 "folder/photoId")
 * @param imageUrl 要下载的图片 URL
 * @returns Promise<R2Object | null> 成功时返回 R2Object 元数据
 * @throws 如果下载或上传失败，则抛出错误
 */
export async function uploadImageToR2(bucket: R2Bucket, r2Key: string, imageUrl: string): Promise<R2Object | null> {
    // 使用 r2Key 更新日志信息
    console.log(`Attempting to download image for R2 key ${r2Key} from ${imageUrl}`);

    // 设置 fetch 超时 (可选, 但对于大文件下载是个好主意)
    // Cloudflare Workers fetch has a default timeout, but explicit shorter one might be needed.
    // const controller = new AbortController();
    // const timeoutId = setTimeout(() => controller.abort(), 60000); // 60秒超时

    try {
        // const response = await fetch(imageUrl, { signal: controller.signal });
        const response = await fetch(imageUrl); // 暂时不用显式超时

        if (!response.ok || !response.body) {
            const errorText = response.ok ? 'Response body is null' : await response.text();
            console.error(`Failed to download image for R2 key ${r2Key}: ${response.status} ${response.statusText}`, errorText);
            throw new Error(`Failed to download image for R2 key ${r2Key}: ${response.status}`);
        }

        console.log(`Uploading image to R2 key: ${r2Key}...`);
        // 使用完整的 r2Key 进行上传
        const r2Object = await bucket.put(r2Key, response.body, {
            httpMetadata: { // 保存原始 Content-Type 和 Cache-Control
                contentType: response.headers.get('Content-Type') ?? undefined,
                cacheControl: response.headers.get('Cache-Control') ?? undefined,
            },
            // customMetadata: { unsplashId: r2Key.split('/').pop() }, // 可选：如果需要从 key 提取 id
        });

        if (r2Object === null) {
            console.error(`Failed to upload image to R2 key ${r2Key} (put returned null).`);
            throw new Error(`Failed to upload image to R2 key ${r2Key}.`);
        }

        console.log(`✅ Successfully saved image to R2 key: ${r2Key}. ETag: ${r2Object.etag}`);
        return r2Object;

    } catch (error) {
        console.error(`❌ Error in uploadImageToR2 for key ${r2Key}:`, error instanceof Error ? error.message : error);
        throw error; // 重新抛出错误，以便上层可以捕获
    } finally {
        // clearTimeout(timeoutId); // 如果使用了显式超时，记得清除
    }
}