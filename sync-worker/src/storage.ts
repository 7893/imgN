// ~/imgN/sync-worker/src/storage.ts
// 版本：尝试通过 httpMetadata 传递 Content-Length (方案 A)

import { R2Bucket, R2HTTPMetadata, R2Object } from '@cloudflare/workers-types';
// 注意：我们这里不需要完整的 Env，只需要 R2Bucket 类型

/**
 * 从指定 URL 下载图片并上传到 R2 Bucket。
 * 尝试通过在 httpMetadata 中传递 Content-Length 来解决流长度未知问题。
 * @param bucket R2Bucket 实例 (来自 env.IMAGE_BUCKET)
 * @param r2Key 要在 R2 中使用的完整对象键 (例如 "folder/photoId")
 * @param imageUrl 要下载的图片 URL
 * @returns Promise<R2Object | null> 成功时返回 R2Object 元数据 (注意: put 在某些条件下返回 null 也算失败)
 * @throws 如果下载失败、响应体为空或上传时发生内部错误，则抛出错误
 */
export async function uploadImageToR2(bucket: R2Bucket, r2Key: string, imageUrl: string): Promise<R2Object | null> {
    console.log(`  Attempting download for R2 key ${r2Key} from ${imageUrl}`);

    let response: Response;
    try {
        response = await fetch(imageUrl, {
            // 可以考虑添加 redirect: 'follow' 等 fetch 选项
            headers: {
                // 可以模仿浏览器发送一些 Accept 头，虽然通常不是必需的
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            }
        });

        if (!response.ok) {
            // 如果下载失败 (非 2xx 状态码)
            const errorText = await response.text();
            console.error(`[R2 Upload] Failed to download image for R2 key ${r2Key}: ${response.status} ${response.statusText}`, errorText.substring(0, 200)); // 限制错误文本长度
            throw new Error(`Failed to download image (${response.status})`);
        }
        if (!response.body) {
            // 如果响应成功但没有 body (理论上图片不该如此)
            console.error(`[R2 Upload] Downloaded image response body is null for R2 key ${r2Key}`);
            throw new Error('Downloaded image has no body');
        }

        console.log(`  Uploading image stream to R2 key: ${r2Key}...`);

        // --- 准备 httpMetadata, 包含 Content-Length (如果存在) ---
        const contentLengthHeader = response.headers.get('content-length');
        const httpMetadata: R2HTTPMetadata = {
            contentType: response.headers.get('Content-Type') ?? undefined, // 保存 Content-Type
            cacheControl: response.headers.get('Cache-Control') ?? undefined, // 保存 Cache-Control
            // 可以根据需要添加其他元数据头，如 ETag, Last-Modified 等
        };
        if (contentLengthHeader) {
            // 将 Content-Length 加入 httpMetadata
            // 注意: 这主要是为了存储元数据，不保证能解决 R2 对流本身长度的要求
            httpMetadata.contentLength = contentLengthHeader;
            console.log(`    Content-Length header found: ${contentLengthHeader}`);
        } else {
            console.warn(`    Content-Length header not found for ${imageUrl}. Upload might fail if R2 requires known stream length.`);
        }
        // --- httpMetadata 准备结束 ---

        // 使用原始 response.body (ReadableStream) 进行上传
        const r2Object = await bucket.put(r2Key, response.body, {
            httpMetadata: httpMetadata,
            // customMetadata: { unsplashId: r2Key.split('/').pop() } // 可选自定义元数据
        });

        // 检查 put 操作是否成功 (返回 null 通常意味着失败，例如 onlyIf 条件不满足)
        // 但更常见的失败形式是抛出异常，会被下面的 catch 捕获
        if (r2Object === null) {
            console.error(`[R2 Upload] Failed to upload to R2 key ${r2Key} (bucket.put returned null).`);
            throw new Error(`R2 put operation returned null for key ${r2Key}.`);
        }

        console.log(`  ✅ Successfully saved image to R2 key: ${r2Key}. ETag: ${r2Object.etag}`);
        return r2Object;

    } catch (error) {
        // 捕获 fetch 或 put 过程中的所有错误
        console.error(`❌ Error in uploadImageToR2 for key ${r2Key}:`, error instanceof Error ? error.message : error);
        // 将错误向上层抛出，让 handleQueue 知道这个操作失败了
        throw error;
    }
}