import { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';

// 定义环境变量/绑定的类型接口
// 确保这里的绑定名称与 wrangler.jsonc 文件中定义的 binding 名称一致
export interface Env {
	DB: D1Database;                // D1 数据库绑定 (用于存储元数据)
	IMAGE_BUCKET: R2Bucket;        // R2 存储桶绑定 (用于存储图片文件)
	// KV_CACHE?: KVNamespace;     // KV 命名空间绑定 (可选, 如果你需要用它)
	
	// Secrets
	UNSPLASH_ACCESS_KEY: string;   // Unsplash API Key
}

// 导出包含 fetch 和 scheduled 处理程序的默认对象
export default {

	/**
	 * 处理 HTTP 请求 (例如浏览器访问 Worker URL)
	 * 返回一个简单的状态页面
	 */
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		console.log(`[${new Date().toISOString()}] Received fetch request: ${request.url}`);
		
		// 返回一个简单的 HTML 页面，表明 Worker 在线
		const html = `
		<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<title>imgn-sync-worker Status</title>
			<style> 
				body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 2em; line-height: 1.6; } 
				h1 { color: #333; }
				p { color: #555; }
				code { background-color: #f4f4f4; padding: 2px 4px; border-radius: 3px; }
			</style>
		</head>
		<body>
			<h1>imgn-sync-worker Status</h1>
			<p>✅ This Worker is running!</p>
			<p>Its main purpose is to periodically sync images from Unsplash based on a Cron schedule.</p>
			<p>You can monitor its activity using <code>wrangler tail imgn-sync-worker</code>.</p>
			<hr>
			<p><em>Current server time: ${new Date().toISOString()}</em></p>
		</body>
		</html>
		`;

		return new Response(html, {
			headers: { 'Content-Type': 'text/html;charset=UTF-8' },
		});
	},

	/**
	 * 处理 Cron 触发的定时任务
	 * 从 Unsplash 获取数据并存入 D1 和 R2
	 */
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log(`[${new Date().toISOString()}] Cron job triggered: Starting Unsplash sync (Trigger: ${controller.cron})...`);

		try {
			// --- 1. 从 Unsplash API 获取数据 ---
			const pageToFetch = 1; // TODO: 实现分页逻辑或随机获取逻辑
			const perPage = 10;    // TODO: 可配置每页数量
			const unsplashUrl = `https://api.unsplash.com/photos?page=${pageToFetch}&per_page=${perPage}&order_by=latest`; // 获取最新图片

			console.log(`Workspaceing from Unsplash: ${unsplashUrl}`);
			const response = await fetch(unsplashUrl, {
				headers: {
					'Authorization': `Client-ID ${env.UNSPLASH_ACCESS_KEY}`,
					'Accept-Version': 'v1', 
				},
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error(`Error fetching from Unsplash: ${response.status} ${response.statusText}`, errorText);
				// 可以添加重试或告警
				return; 
			}

			const photos: any[] = await response.json(); 
			console.log(`Workspaceed ${photos.length} photos from Unsplash.`);

			if (photos.length === 0) {
				console.log("No new photos fetched in this batch, sync finished.");
				return;
			}

			// --- 2. 准备 D1 Upsert SQL 语句 ---
			// 使用你之前定义的 image_metadata 表结构
			const stmt = env.DB.prepare(
				`INSERT INTO image_metadata (
					photo_id, photo_url, file_size, category, resolution, color, 
					author_info, exif, location, image_urls, likes, views, downloads, 
					updated_at, tags, public_domain, slug
				) VALUES (
					?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
				) ON CONFLICT(photo_id) DO UPDATE SET 
					photo_url=excluded.photo_url, file_size=excluded.file_size, category=excluded.category, 
					resolution=excluded.resolution, color=excluded.color, author_info=excluded.author_info, 
					exif=excluded.exif, location=excluded.location, image_urls=excluded.image_urls, 
					likes=excluded.likes, views=excluded.views, downloads=excluded.downloads,
					updated_at=excluded.updated_at, tags=excluded.tags, public_domain=excluded.public_domain, 
					slug=excluded.slug, synced_at=CURRENT_TIMESTAMP`
			);

			// --- 3. 准备批量操作的数据 ---
			const operations: D1PreparedStatement[] = photos.map(photo => {
				// 提取数据并进行必要的格式化/序列化
				const photoId = photo.id ?? null;
				const photoUrl = photo.urls?.regular ?? photo.urls?.raw ?? null; 
				const fileSize = null; // 列表 API 通常不提供
				const category = null; // 列表 API 通常不直接提供
				const resolution = photo.width && photo.height ? `${photo.width}x${photo.height}` : null;
				const color = photo.color ?? null;
				const authorInfo = photo.user ? JSON.stringify(photo.user) : null; 
				const exif = photo.exif ? JSON.stringify(photo.exif) : null; 
				const location = photo.location ? JSON.stringify(photo.location) : null; 
				const imageUrls = photo.urls ? JSON.stringify(photo.urls) : null; 
				const likes = photo.likes ?? 0;
				const views = photo.views ?? 0; // 需确认 API 是否返回
				const downloads = photo.downloads ?? 0; // 需确认 API 是否返回
				const updatedAt = photo.updated_at ?? photo.created_at ?? null; 
				// 提取 tag 的 title 属性组成数组，再转 JSON
				const tags = photo.tags ? JSON.stringify(photo.tags.map((tag: any) => tag?.title).filter(Boolean)) : null; 
				const publicDomain = 0; // 假设默认为 false
				const slug = photo.slug ?? null;

				// 确保 photo_id 存在才进行绑定
				if (!photoId) {
					console.warn("Skipping photo due to missing ID:", photo);
					return null; // 返回 null 或其他标记以过滤掉无效操作
				}

				return stmt.bind(
					photoId, photoUrl, fileSize, category, resolution, color, 
					authorInfo, exif, location, imageUrls, likes, views, downloads,
					updatedAt, tags, publicDomain, slug
				);
			}).filter(Boolean) as D1PreparedStatement[]; // 过滤掉可能产生的 null 值

			console.log(`Prepared ${operations.length} statements for D1 batch operation.`);

			// --- 4. 执行 D1 批量写入 ---
			if (operations.length > 0) {
				ctx.waitUntil(
					env.DB.batch(operations)
					.then(results => {
						console.log(`D1 batch metadata update finished. Statements executed: ${operations.length}`);
					})
					.catch(err => {
						console.error('Error executing D1 batch operation:', err);
					})
				);
			} else {
				console.log("No valid operations prepared for D1 batch.");
			}
			
			// --- 5. (TODO) 下载图片存入 R2 ---
			//  需要添加逻辑：遍历 photos，获取图片 URL (如 raw_url)，
			//  使用 fetch 下载图片内容 (blob)，
			//  然后使用 env.IMAGE_BUCKET.put(photoId, blob) 存入 R2。
			//  注意处理错误和 ctx.waitUntil()。
			// -------------------------------

			console.log(`[${new Date().toISOString()}] Cron job: Sync batch completed.`);

		} catch (error) {
			console.error(`[${new Date().toISOString()}] Cron job failed unexpectedly:`, error instanceof Error ? error.message : error);
		}
	},

	// 如果需要处理队列消息，可以在这里添加 queue 处理程序
	// async queue(batch: MessageBatch<any>, env: Env, ctx: ExecutionContext): Promise<void> {
	//   // ... 队列处理逻辑 ...
	// }
};