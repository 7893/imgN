// ~/imgN/sync-worker/src/storage.ts (修正：使用 response.blob())
import { R2Bucket, R2HTTPMetadata, R2Object } from '@cloudflare/workers-types';

/**
 * 从指定 URL 下载图片并上传到 R2 Bucket。(使用 Blob 解决长度问题)
 */
export async function uploadImageToR2(bucket: R2Bucket, r2Key: string, imageUrl: string): Promise<R2Object | null> {
    console.log(`  Attempting download for R2 key ${r2Key} from ${imageUrl}`);
    let response: Response;
    try {
        response = await fetch(imageUrl);
        if (!response.ok) { throw new Error(`Failed download: ${response.status}`); }
        if (!response.body) { throw new Error('Downloaded image has no body'); }

        // *** 修改点：将响应体读取为 Blob ***
        console.log(`  Buffering image into Blob for ${r2Key}...`);
        const imageBlob = await response.blob();
        console.log(`  Image buffered (size: ${imageBlob.size} bytes). Uploading to R2 key: ${r2Key}...`);
        // *** 结束修改点 ***

        const httpMetadata: R2HTTPMetadata = {
            contentType: imageBlob.type || response.headers.get('Content-Type') || undefined, // 优先用 Blob 的 type
            cacheControl: response.headers.get('Cache-Control') ?? undefined,
        };

        // *** 修改点：使用 Blob 上传 ***
        const r2Object = await bucket.put(r2Key, imageBlob, { httpMetadata });

        if (r2Object === null) { throw new Error(`R2 put returned null.`); }

        console.log(`  ✅ Saved to R2: ${r2Key}. ETag: ${r2Object.etag}`);
        return r2Object;

    } catch (error: any) {
        console.error(`❌ Error in uploadImageToR2 for key ${r2Key}:`, error.message);
        throw error;
    }
}