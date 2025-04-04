// src/storage.ts
import { Env } from './types'; // 如果 Env 定义在 types.ts

/**
 * 从指定 URL 下载图片并上传到 R2 Bucket。
 * @param bucket R2Bucket 实例 (来自 env.IMAGE_BUCKET)
 * @param photoId 图片的唯一 ID (用作 R2 Key)
 * @param imageUrl 要下载的图片 URL
 * @returns Promise<void>
 * @throws 如果下载或上传失败，则抛出错误
 */
export async function uploadImageToR2(bucket: R2Bucket, photoId: string, imageUrl: string): Promise<R2Object | null> {
    console.log(`Attempting to download image ${photoId} from ${imageUrl}`);
    const response = await fetch(imageUrl);

    if (!response.ok || !response.body) {
        const errorText = response.ok ? 'Response body is null' : await response.text();
        console.error(`Failed to download image ${photoId}: ${response.status} ${response.statusText}`, errorText);
        throw new Error(`Failed to download image ${photoId}: ${response.status}`);
    }

    console.log(`Uploading image ${photoId} to R2...`);
    // 使用 photoId 作为 R2 的 Key (文件名)
    // put 方法可以直接处理 Response Body (ReadableStream)
    // 传递 httpMetadata 以便 R2 能正确设置 Content-Type 等
    const r2Object = await bucket.put(photoId, response.body, {
        httpMetadata: {
            contentType: response.headers.get('Content-Type') ?? undefined,
            cacheControl: response.headers.get('Cache-Control') ?? undefined,
        },
        // customMetadata: { unsplashId: photoId }, // 可选：添加自定义元数据
    });

    if (r2Object === null) {
        console.error(`Failed to upload image ${photoId} to R2 (put returned null).`);
        throw new Error(`Failed to upload image ${photoId} to R2.`);
    }

    console.log(`✅ Successfully saved image ${photoId} to R2. ETag: ${r2Object.etag}`);
    return r2Object; // 返回 R2Object 元数据
}