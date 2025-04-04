// src/unsplash.ts
import { Env, UnsplashPhoto } from './types';

const API_BASE = 'https://api.unsplash.com';

/**
 * 从 Unsplash API 获取最新照片列表。
 * @param env Worker 环境变量和绑定
 * @param page 要获取的页码
 * @param perPage 每页数量
 * @returns Promise<UnsplashPhoto[]> 解析后的照片数据数组
 * @throws 如果 API 请求失败或响应不成功，则抛出错误
 */
export async function fetchLatestPhotos(env: Env, page: number = 1, perPage: number = 10): Promise<UnsplashPhoto[]> {
    const url = `${API_BASE}/photos?page=${page}&per_page=${perPage}&order_by=latest`;
    console.log(`Workspaceing from Unsplash: ${url}`);

    const response = await fetch(url, {
        headers: {
            'Authorization': `Client-ID ${env.UNSPLASH_ACCESS_KEY}`,
            'Accept-Version': 'v1',
        },
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`Error fetching from Unsplash: ${response.status} ${response.statusText}`, errorText);
        // 可以根据 status code 做更细致的处理，例如 403 (Rate Limit), 401 (Invalid Key)
        throw new Error(`Unsplash API Error: ${response.status} ${response.statusText}`);
    }

    const photos: UnsplashPhoto[] = await response.json();
    console.log(`Workspaceed ${photos.length} photos from Unsplash.`);
    return photos;
}