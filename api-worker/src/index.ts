import { ExecutionContext } from '@cloudflare/workers-types';

// 定义环境变量/绑定的类型接口
// 确保这里的绑定名称与 api-worker/wrangler.jsonc 文件中定义的 binding 名称一致
export interface Env {
	DB: D1Database;                // D1 数据库绑定 (必须)
	// KV_CACHE?: KVNamespace;      // KV 命名空间绑定 (可选, 用于缓存)
}

// --- CORS (跨域资源共享) 配置 ---
// 允许任何来源访问 (最简单配置)。在生产环境中，你可能希望限制为你的 Pages 域名。
const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', // API 只需支持 GET
	'Access-Control-Allow-Headers': 'Content-Type',
};

// 添加 CORS 头到响应的辅助函数
function addCorsHeaders(response: Response): Response {
	Object.entries(corsHeaders).forEach(([key, value]) => {
		response.headers.set(key, value);
	});
	return response;
}

// --- Worker 入口 ---
export default {
	/**
	 * 处理所有传入的 HTTP 请求
	 */
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {

		// 预检请求 (CORS OPTIONS) 处理
		if (request.method === 'OPTIONS') {
			return addCorsHeaders(new Response(null, { status: 204 })); // No Content
		}

		const url = new URL(request.url);

		try {
			// --- 简单路由 ---
			if (url.pathname === '/images' && request.method === 'GET') {
				// --- 处理 /images GET 请求 ---
				console.log(`[${new Date().toISOString()}] Request received for /images`);

				// 解析分页参数 (来自 URL 查询字符串 ?page=X&limit=Y)
				const params = url.searchParams;
				const page = parseInt(params.get('page') || '1', 10);
				const limit = parseInt(params.get('limit') || '12', 10); // 默认每页 12 条

				// 基本的参数验证和范围限制
				const pageNum = Math.max(1, isNaN(page) ? 1 : page);
				// 限制每页最多 50 条，最少 1 条
				const limitNum = Math.min(50, Math.max(1, isNaN(limit) ? 12 : limit));
				const offset = (pageNum - 1) * limitNum;

				console.log(`Querying D1 (table: img3_metadata): page=${pageNum}, limit=${limitNum}, offset=${offset}`);

				// 准备 D1 查询语句 (使用我们最终确定的表名 img3_metadata)
				// 按 Unsplash 上图片更新时间倒序排列
				const query = `
					SELECT * FROM img3_metadata 
					ORDER BY updated_at_api DESC 
					LIMIT ?1 OFFSET ?2; 
				`;
				const stmt = env.DB.prepare(query).bind(limitNum, offset);

				// 执行查询
				const { results, success, error } = await stmt.all();

				if (!success) {
					console.error(`[${new Date().toISOString()}] D1 query failed:`, error);
					throw new Error(`Database query failed: ${error}`);
				}

				console.log(`D1 query returned ${results?.length ?? 0} results.`);

				// 准备成功的 JSON 响应体
				const responsePayload = {
					success: true,
					data: {
						images: results ?? [], // 确保即使没结果也返回空数组
						page: pageNum,
						limit: limitNum,
						// 注意：要获取总数需要额外执行 COUNT(*) 查询，这里暂时省略
					},
					message: "Images fetched successfully."
				};

				// 创建 JSON 响应
				const response = new Response(JSON.stringify(responsePayload), {
					headers: { 'Content-Type': 'application/json' },
					status: 200
				});
				return addCorsHeaders(response); // 添加 CORS 头

			} else if (url.pathname === '/' || url.pathname === '/health') {
				// --- 处理根路径 / 或 /health GET 请求 (简单健康检查) ---
				const html = `<!DOCTYPE html><body><h1>imgn-api-worker is running!</h1><p>API endpoint available at /images</p><p>Time: ${new Date().toISOString()}</p></body></html>`;
				const response = new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
				return addCorsHeaders(response);

			} else {
				// --- 处理 404 Not Found ---
				const response = new Response(JSON.stringify({ success: false, error: 'Not Found', message: `Endpoint [${request.method}] ${url.pathname} not found.` }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' },
				});
				return addCorsHeaders(response);
			}

		} catch (error) {
			// --- 通用错误处理 ---
			console.error(`[${new Date().toISOString()}] Error processing request ${request.url}:`, error);
			const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
			const response = new Response(JSON.stringify({ success: false, error: 'Internal Server Error', message: errorMessage }), {
				status: 500, // Internal Server Error
				headers: { 'Content-Type': 'application/json' },
			});
			return addCorsHeaders(response);
		}
	},
};