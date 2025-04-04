import { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';

// 定义环境变量/绑定的类型接口
// 确保这里的绑定名称与 wrangler.jsonc 文件中定义的 binding 名称一致
export interface Env {
	DB: D1Database;
	IMAGE_BUCKET: R2Bucket;
	// KV_CACHE?: KVNamespace; 
	UNSPLASH_ACCESS_KEY: string;
}

// 导出包含 fetch 和 scheduled 处理程序的默认对象
export default {

	/**
	 * 处理 HTTP 请求 (简单的状态页面)
	 */
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		console.log(`[${new Date().toISOString()}] Received fetch request: ${request.url}`);
		const html = `
		<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>imgn-sync-worker Status</title><style>body{font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding:2em; line-height:1.6;}h1{color:#333;}p{color:#555;}code{background-color:#f4f4f4; padding:2px 4px; border-radius:3px;}</style></head>
		<body><h1>imgn-sync-worker Status</h1><p>✅ This Worker is running!</p><p>Its main purpose is to periodically sync images from Unsplash based on a Cron schedule.</p><p>You can monitor its activity using <code>wrangler tail imgn-sync-worker</code>.</p><hr><p><em>Current server time: ${new Date().toISOString()}</em></p></body></html>`;
		return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
	},

	/**
	 * 处理 Cron 触发的定时任务 (修改了 SQL 语句)
	 */
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log(`[${new Date().toISOString()}] Cron job triggered: Starting Unsplash sync (Trigger: ${controller.cron})...`);

		try {
			// --- 1. 从 Unsplash API 获取数据 ---
			const pageToFetch = 1; // TODO: Implement pagination/randomization
			const perPage = 10;    // TODO: Make configurable
			const unsplashUrl = `https://api.unsplash.com/photos?page=${pageToFetch}&per_page=${perPage}&order_by=latest`;

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
				return;
			}

			const photos: any[] = await response.json();
			console.log(`Workspaceed ${photos.length} photos from Unsplash.`);
			if (photos.length === 0) {
				console.log("No new photos fetched in this batch, sync finished.");
				return;
			}

			// --- 2. 准备 D1 Upsert SQL 语句 (适配新的 img3_metadata 表结构) ---
			// 注意: INSERT 和 DO UPDATE SET 子句中不再包含 synced_at
			const stmt = env.DB.prepare(
				`INSERT INTO img3_metadata (
					id, description, alt_description, color, blur_hash, width, height, 
					created_at_api, updated_at_api, likes, views, downloads, 
					image_urls, photo_links, author_details, location_details, exif_data, tags_data, slug
				) VALUES (
					?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
				) ON CONFLICT(id) DO UPDATE SET 
					description=excluded.description, 
					alt_description=excluded.alt_description, 
					color=excluded.color, 
					blur_hash=excluded.blur_hash, 
					width=excluded.width, 
					height=excluded.height, 
					created_at_api=excluded.created_at_api, 
					updated_at_api=excluded.updated_at_api, 
					likes=excluded.likes, 
					views=excluded.views, 
					downloads=excluded.downloads, 
					image_urls=excluded.image_urls, 
					photo_links=excluded.photo_links, 
					author_details=excluded.author_details, 
					location_details=excluded.location_details, 
					exif_data=excluded.exif_data, 
					tags_data=excluded.tags_data, 
					slug=excluded.slug`
				// 注意: 这里末尾不再有 ", synced_at=CURRENT_TIMESTAMP"
			);

			// --- 3. 准备批量操作的数据 (适配新的列) ---
			const operations: D1PreparedStatement[] = photos.map(photo => {
				const photoId = photo.id ?? null;
				if (!photoId) {
					console.warn("Skipping photo due to missing ID:", photo);
					return null;
				}
				// 提取并绑定到对应的列
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
				const tags_data = photo.tags ? JSON.stringify(photo.tags.map((tag: any) => tag?.title).filter(Boolean)) : null;
				const slug = photo.slug ?? null;

				return stmt.bind( // 确保绑定参数的数量和顺序与 VALUES() 中的 ? 占位符一致
					photoId, description, alt_description, color, blur_hash, width, height,
					created_at_api, updated_at_api, likes, views, downloads,
					image_urls, photo_links, author_details, location_details, exif_data, tags_data, slug
				);
			}).filter(Boolean) as D1PreparedStatement[];

			console.log(`Prepared ${operations.length} statements for D1 batch operation.`);

			// --- 4. 执行 D1 批量写入 ---
			if (operations.length > 0) {
				ctx.waitUntil(
					env.DB.batch(operations)
						.then(results => {
							console.log(`D1 batch metadata update finished. Statements executed: ${operations.length}`);
						})
						.catch(err => {
							// 理论上不应该再报 synced_at 错误了，但保留错误捕获
							console.error('Error executing D1 batch operation:', err);
						})
				);
			} else {
				console.log("No valid operations prepared for D1 batch.");
			}

			// --- 5. (TODO) R2 逻辑 ---
			// ...

			console.log(`[${new Date().toISOString()}] Cron job: Sync batch completed.`);

		} catch (error) {
			console.error(`[${new Date().toISOString()}] Cron job failed unexpectedly:`, error instanceof Error ? error.message : error);
		}
	},
};