// ~/imgN/api-worker/src/index.ts
import { ExecutionContext } from '@cloudflare/workers-types';
import { SyncCoordinatorDO } from './sync-coordinator-do';
import { Env } from './types'; // 假设 Env 定义在 api-worker/src/types.ts

// 导出 DO 类，供运行时使用
export { SyncCoordinatorDO };

// --- CORS 处理 ---
const corsHeaders = {
	'Access-Control-Allow-Origin': '*', // 生产环境应替换为你的 Pages 域名
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
	'Access-Control-Max-Age': '86400',
};
function addCorsHeaders(response: Response): Response {
	// 创建新的 Headers 对象来添加 CORS 头，因为原始 Response Headers 不可变
	const newHeaders = new Headers(response.headers);
	Object.entries(corsHeaders).forEach(([key, value]) => {
		newHeaders.set(key, value);
	});
	// 使用原始响应体和状态，但使用新的 Headers 对象
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: newHeaders
	});
}
function handleOptions(request: Request): Response {
	if (request.headers.get('Origin') !== null &&
		request.headers.get('Access-Control-Request-Method') !== null &&
		request.headers.get('Access-Control-Request-Headers') !== null) {
		return new Response(null, { headers: corsHeaders });
	} else {
		return new Response(null, { headers: { Allow: 'GET, POST, OPTIONS' } });
	}
}

// --- Worker 主逻辑 ---
export default {
	/**
	 * 处理所有进入 api-worker 的 HTTP 请求
	 */
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {

		if (request.method === 'OPTIONS') {
			return handleOptions(request);
		}

		const url = new URL(request.url);
		const path = url.pathname;
		let response: Response; // 用于存储最终响应

		try {
			// 定义需要与 DO 交互的路径
			const doPaths = ['/start-sync', '/stop-sync', '/sync-status', '/report-sync-page', '/reset-sync-do'];

			if (doPaths.includes(path)) { // 如果是需要 DO 处理的路径

				const doNamespace = env.SYNC_COORDINATOR_DO;
				const doId = doNamespace.idFromName("sync-coordinator-singleton");
				const doStub = doNamespace.get(doId);
				let doPath = ''; // DO 内部路径
				let internalMethod = request.method; // 默认方法

				// 映射 API 路径到 DO 内部路径
				if (path === '/start-sync') doPath = '/start';
				else if (path === '/stop-sync') doPath = '/stop';
				else if (path === '/sync-status') doPath = '/status';
				else if (path === '/report-sync-page') doPath = '/report';
				else if (path === '/reset-sync-do') doPath = '/reset';

				// 基本的方法检查
				const requiresPost = ['/start', '/stop', '/report', '/reset'].includes(doPath);
				const requiresGet = ['/status'].includes(doPath);

				if ((requiresPost && request.method !== 'POST') || (requiresGet && request.method !== 'GET')) {
					response = new Response(`Method Not Allowed (${request.method} for ${path})`, { status: 405 });
				} else {
					console.log(`[API Worker] Forwarding ${request.method} ${path} to DO path ${doPath}...`);

					// 创建转发给 DO 的请求
					// 使用原始请求来构造新的请求，确保 Headers 和 Body (如果存在且是 POST/PUT/PATCH) 被传递
					let doRequest = new Request(`https://do-internal${doPath}`, request);

					// 调用 DO 的 fetch 方法并等待响应
					response = await doStub.fetch(doRequest);
				}

			} else if (path === '/' || path === '/health') {
				// 健康检查端点
				const html = `<!DOCTYPE html><body><h1>imgn-api-worker is running!</h1><p>Sync control endpoints: /start-sync (POST), /stop-sync (POST), /sync-status (GET), /reset-sync-do (POST)</p><p>Time: ${new Date().toISOString()}</p></body></html>`;
				response = new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });

			} else {
				// 其他未匹配路径返回 404
				response = new Response(JSON.stringify({ success: false, error: 'Not Found' }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			// 为所有从此 Worker 返回的响应添加 CORS 头
			return addCorsHeaders(response); // 注意：这里会克隆 Response

		} catch (error: any) {
			// --- 通用错误处理 ---
			console.error(`[API Worker] Error processing request ${request.url}:`, error);
			const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
			response = new Response(JSON.stringify({ success: false, error: 'Internal Server Error', message: errorMessage }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
			return addCorsHeaders(response); // 错误响应也添加 CORS
		}
	},
};