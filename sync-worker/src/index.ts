import { ExecutionContext } from '@cloudflare/workers-types';

// 定义环境变量/绑定的类型接口
export interface Env {
	// --- Bindings configured in wrangler.jsonc ---
	DB: D1Database;                // D1 数据库绑定
	IMAGE_BUCKET: R2Bucket;        // R2 存储桶绑定 (稍后用于存图片)
	// KV_CACHE: KVNamespace;      // KV 命名空间绑定 (如果需要)
	
	// --- Secrets ---
	UNSPLASH_ACCESS_KEY: string;   // Unsplash API Key
}

export default {
	// 使用 scheduled handler 来响应 Cron 触发器
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log(`[${new Date().toISOString()}] Cron job triggered: Starting Unsplash sync...`);

		try {
			// --- 1. 从 Unsplash API 获取数据 ---
			// 简单示例：获取最新照片列表，第一页，每页 10 张
			// TODO: 将来需要实现分页逻辑来获取更多数据
			const pageToFetch = 1; 
			const perPage = 10;
			const unsplashUrl = `https://api.unsplash.com/photos?page=${pageToFetch}&per_page=${perPage}`;

			console.log(`Workspaceing from Unsplash: ${unsplashUrl}`);
			const response = await fetch(unsplashUrl, {
				headers: {
					'Authorization': `Client-ID ${env.UNSPLASH_ACCESS_KEY}`,
					'Accept-Version': 'v1', // 推荐指定 API 版本
				},
			});

			if (!response.ok) {
				// 处理 API 错误，例如速率限制
				const errorText = await response.text();
				console.error(`Error fetching from Unsplash: ${response.status} ${response.statusText}`, errorText);
				// 可以考虑在这里加入重试逻辑或通知机制
				return; // 提前退出本次执行
			}

			// 解析返回的图片数据数组
			const photos: any[] = await response.json(); // 使用 any 类型简化处理，实际项目中建议定义 Unsplash Photo 类型
			console.log(`Workspaceed ${photos.length} photos from Unsplash.`);

			if (photos.length === 0) {
				console.log("No new photos fetched, sync finished.");
				return;
			}

			// --- 2. 准备 SQL 语句 (使用 Upsert 逻辑) ---
			// 如果 photo_id 已存在，则更新记录，否则插入新记录
			const stmt = env.DB.prepare(
				`INSERT INTO image_metadata (
					photo_id, photo_url, file_size, category, resolution, color, 
					author_info, exif, location, image_urls, likes, views, downloads, 
					updated_at, tags, public_domain, slug
				) VALUES (
					?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
				) ON CONFLICT(photo_id) DO UPDATE SET 
					photo_url=excluded.photo_url, 
					file_size=excluded.file_size, 
					category=excluded.category, 
					resolution=excluded.resolution, 
					color=excluded.color,
					author_info=excluded.author_info, 
					exif=excluded.exif, 
					location=excluded.location, 
					image_urls=excluded.image_urls, 
					likes=excluded.likes, 
					views=excluded.views, 
					downloads=excluded.downloads,
					updated_at=excluded.updated_at, 
					tags=excluded.tags, 
					public_domain=excluded.public_domain, 
					slug=excluded.slug,
					synced_at=CURRENT_TIMESTAMP` // 更新 synced_at 时间
			);

			// --- 3. 遍历图片数据并绑定到 SQL 语句 ---
			const operations: D1PreparedStatement[] = photos.map(photo => {
				// 准备需要存入数据库的值，尽量保持原始，对结构体进行 JSON 序列化
				const photoId = photo.id;
				const photoUrl = photo.urls?.regular ?? photo.urls?.raw ?? null; // 优先 regular，其次 raw
				const fileSize = null; // Unsplash 列表 API 通常不直接提供文件大小
				const category = null; // Unsplash API 通常不直接提供单一 category，可能需要从 tags 推断或留空
				const resolution = photo.width && photo.height ? `${photo.width}x${photo.height}` : null;
				const color = photo.color ?? null; // Unsplash 返回的主色调
				const authorInfo = photo.user ? JSON.stringify(photo.user) : null; // 作者信息结构体转 JSON
				const exif = photo.exif ? JSON.stringify(photo.exif) : null; // EXIF 信息结构体转 JSON
				const location = photo.location ? JSON.stringify(photo.location) : null; // 地理位置结构体转 JSON
				const imageUrls = photo.urls ? JSON.stringify(photo.urls) : null; // 图片 URL 结构体转 JSON
				const likes = photo.likes ?? 0;
				const views = photo.views ?? 0; // 列表 API 可能不返回 views/downloads，需要确认
				const downloads = photo.downloads ?? 0;
				const updatedAt = photo.updated_at ?? null; // ISO 8601 格式字符串
				const tags = photo.tags ? JSON.stringify(photo.tags.map((tag: any) => tag.title)) : null; // 提取 tag 的 title 组成数组，再转 JSON
				const publicDomain = 0; // 列表 API 通常不直接标明，假设为 false(0)，或根据需要从 Unsplash 文档确认
				const slug = photo.slug ?? null; 

				// 绑定参数到 PreparedStatement
				return stmt.bind(
					photoId, photoUrl, fileSize, category, resolution, color, 
					authorInfo, exif, location, imageUrls, likes, views, downloads,
					updatedAt, tags, publicDomain, slug
				);
			});

			console.log(`Prepared ${operations.length} statements for D1 batch operation.`);

			// --- 4. 执行批量数据库操作 ---
			// 使用 D1 的 batch() 方法可以更高效地执行多个语句
			// ctx.waitUntil() 确保即使 scheduled 函数返回了，数据库操作也能继续完成
			ctx.waitUntil(
				env.DB.batch(operations)
				.then(results => {
					console.log(`D1 batch operation finished. Results count: ${results.length}`);
					// 可以在这里检查 results 数组看是否有单独失败的操作
				})
				.catch(err => {
					console.error('Error executing D1 batch operation:', err);
				})
			);

			// --- 5. (TODO - 下一步) 下载图片并存入 R2 ---
			// for (const photo of photos) {
			//   const imageUrl = photo.urls?.raw; // 选择要下载的 URL
			//   const imageId = photo.id;
			//   if (imageUrl) {
			//     ctx.waitUntil(
			//       fetch(imageUrl)
			//         .then(res => res.blob())
			//         .then(blob => env.IMAGE_BUCKET.put(`${imageId}.jpg`, blob)) // 使用 photo_id 作为 R2 Key
			//         .then(() => console.log(`Saved image ${imageId} to R2.`))
			//         .catch(err => console.error(`Error saving image ${imageId} to R2:`, err))
			//     );
			//   }
			// }

			console.log(`[${new Date().toISOString()}] Cron job: Sync completed successfully.`);

		} catch (error) {
			console.error(`[${new Date().toISOString()}] Cron job failed:`, error);
			// 在实际应用中，这里可能需要更健壮的错误报告机制
		}
	},
};
