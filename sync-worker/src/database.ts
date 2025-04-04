// src/database.ts
import { UnsplashPhoto } from './types';

/**
 * 将 Unsplash 照片元数据批量 Upsert (插入或更新) 到 D1 数据库。
 * @param db D1Database 实例 (来自 env.DB)
 * @param photos 从 Unsplash API 获取的照片数据数组
 * @returns Promise<D1Result[]> D1 batch 操作的结果数组
 * @throws 如果准备语句或执行批量操作失败，则抛出错误
 */
export async function upsertPhotoMetadataBatch(db: D1Database, photos: UnsplashPhoto[]): Promise<D1Result[]> {
    if (!photos || photos.length === 0) {
        console.log("No photos provided for D1 upsert.");
        return [];
    }

    // 准备 Upsert SQL 语句 (适配 images_metadata 表结构, 无 synced_at)
    const stmt = db.prepare(
        `INSERT INTO img3_metadata (
			id, description, alt_description, color, blur_hash, width, height, 
			created_at_api, updated_at_api, likes, views, downloads, 
			image_urls, photo_links, author_details, location_details, exif_data, tags_data, slug
		) VALUES (
			?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
		) ON CONFLICT(id) DO UPDATE SET 
			description=excluded.description, alt_description=excluded.alt_description, color=excluded.color, 
			blur_hash=excluded.blur_hash, width=excluded.width, height=excluded.height, 
			created_at_api=excluded.created_at_api, updated_at_api=excluded.updated_at_api, 
			likes=excluded.likes, views=excluded.views, downloads=excluded.downloads, 
			image_urls=excluded.image_urls, photo_links=excluded.photo_links, 
			author_details=excluded.author_details, location_details=excluded.location_details, 
			exif_data=excluded.exif_data, tags_data=excluded.tags_data, slug=excluded.slug`
    );

    // 准备批量操作的数据
    const operations: D1PreparedStatement[] = photos
        .map((photo) => {
            const photoId = photo.id ?? null;
            if (!photoId) {
                console.warn('Skipping photo due to missing ID:', photo);
                return null;
            }
            // 提取并格式化数据
            const description = photo.description ?? null;
            const alt_description = photo.alt_description ?? null;
            const color = photo.color ?? null;
            const blur_hash = photo.blur_hash ?? null;
            const width = photo.width ?? null;
            const height = photo.height ?? null;
            const created_at_api = photo.created_at ?? null;
            const updated_at_api = photo.updated_at ?? null;
            const likes = photo.likes ?? 0;
            const views = photo.views ?? 0;
            const downloads = photo.downloads ?? 0;
            const image_urls = photo.urls ? JSON.stringify(photo.urls) : null;
            const photo_links = photo.links ? JSON.stringify(photo.links) : null;
            const author_details = photo.user ? JSON.stringify(photo.user) : null;
            const location_details = photo.location ? JSON.stringify(photo.location) : null;
            const exif_data = photo.exif ? JSON.stringify(photo.exif) : null;
            const tags_data = photo.tags ? JSON.stringify(photo.tags.map((tag) => tag?.title).filter(Boolean)) : null;
            const slug = photo.slug ?? null;

            // 绑定参数
            try {
                return stmt.bind(
                    photoId, description, alt_description, color, blur_hash, width, height,
                    created_at_api, updated_at_api, likes, views, downloads,
                    image_urls, photo_links, author_details, location_details, exif_data, tags_data, slug
                );
            } catch (bindError) {
                console.error(`Error binding data for photo ID ${photoId}:`, bindError);
                return null; // 跳过这个错误的数据
            }
        })
        .filter(Boolean) as D1PreparedStatement[]; // 过滤掉可能产生的 null 值

    console.log(`Prepared ${operations.length} statements for D1 batch operation.`);

    if (operations.length > 0) {
        // 执行批量操作
        console.log("Executing D1 batch operation...");
        return await db.batch(operations);
    } else {
        console.log("No valid operations prepared for D1 batch.");
        return [];
    }
}