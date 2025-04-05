// ~/imgN/api-worker/src/routes.ts
import { IRequest, StatusError } from 'itty-router';
import { Env } from './types';

// 辅助函数：获取 DO Stub (单例)
function getDoStub(env: Env): DurableObjectStub {
    try {
        const doNamespace = env.SYNC_COORDINATOR_DO;
        const doId = doNamespace.idFromName("sync-coordinator-singleton");
        return doNamespace.get(doId);
    } catch (e: any) {
        console.error("[API Routes] 获取 DO Stub 失败:", e);
        throw new StatusError(500, "Durable Object 绑定配置错误或获取失败。");
    }
}

// 辅助函数：将请求转发给 DO
async function forwardToDo(request: IRequest, env: Env, internalPath: string): Promise<Response> {
    const doStub = getDoStub(env);
    const doUrl = new URL(request.url); // 使用原始请求 URL 来构造内部 URL
    doUrl.pathname = internalPath; // 设置 DO 内部要处理的路径
    console.log(`[API Route Handler] 转发 ${request.method} ${request.path} 到 DO 路径 ${internalPath}...`);
    // 使用原始请求对象转发，它包含了方法、头部、主体等
    return doStub.fetch(doUrl.toString(), request);
}

// --- 路由处理函数 ---

export async function handleStartSync(request: IRequest, env: Env): Promise<Response> {
    return forwardToDo(request, env, '/start');
}

export async function handleStopSync(request: IRequest, env: Env): Promise<Response> {
    return forwardToDo(request, env, '/stop');
}

export async function handleStatus(request: IRequest, env: Env): Promise<Response> {
    return forwardToDo(request, env, '/status');
}

export async function handleReport(request: IRequest, env: Env): Promise<Response> {
    return forwardToDo(request, env, '/report');
}

export async function handleReset(request: IRequest, env: Env): Promise<Response> {
    return forwardToDo(request, env, '/reset');
}

export async function handleHealth(request: IRequest, env: Env): Promise<Response> {
    // 健康检查不一定需要访问 DO
    const html = `<!DOCTYPE html><body><h1>imgn-api-worker is running!</h1><p>Time: ${new Date().toISOString()}</p></body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// 处理 /images 请求 (包含 KV 缓存逻辑)
export async function handleGetImages(request: IRequest, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url); // itty-router 的 request 对象可能没有 url，需要从原始 request 获取，或者 itty-router 提供了方式
    // 注意：itty-router 的 request (IRequest) 可能需要不同的方式获取查询参数
    // 假设我们可以通过 request.query 获取
    const page = parseInt(request.query?.page || '1', 10);
    const limit = parseInt(request.query?.limit || '10', 10); // 默认 10

    const pageNum = Math.max(1, isNaN(page) ? 1 : page);
    const limitNum = Math.min(50, Math.max(1, isNaN(limit) ? 10 : limit));

    const cacheKey = `images_p${pageNum}_l${limitNum}`;
    console.log(`[Cache] 检查 Key: ${cacheKey}`);

    try {
        const cachedData = await env.KV_CACHE.get(cacheKey, "text");
        if (cachedData !== null) {
            console.log(`[Cache] 命中 Key: ${cacheKey}`);
            return new Response(cachedData, { headers: { 'Content-Type': 'application/json', 'X-Cache-Status': 'hit' } });
        } else {
            console.log(`[Cache] 未命中 Key: ${cacheKey}. 查询 D1...`);
            const offset = (pageNum - 1) * limitNum;
            // ... (D1 查询逻辑 - count + data) ...
            const countStmt = env.DB.prepare(`SELECT COUNT(*) as total FROM img3_metadata;`);
            const dataStmt = env.DB.prepare(`SELECT * FROM img3_metadata ORDER BY created_at_api DESC LIMIT ?1 OFFSET ?2;`).bind(limitNum, offset);
            const [countResult, dataResult] = await Promise.all([countStmt.first<{ total: number }>(), dataStmt.all()]);
            if (!dataResult.success) { throw new Error(`D1 查询失败: ${dataResult.error}`); }
            const totalImages = countResult?.total ?? 0; const totalPages = Math.ceil(totalImages / limitNum); const images = dataResult.results ?? [];
            // ... (构造 responsePayload) ...
            const responsePayload = { success: true, data: { images, page: pageNum, limit: limitNum, totalImages, totalPages }, message: "从源获取成功。" };
            const responsePayloadString = JSON.stringify(responsePayload);
            // ... (异步写入 KV) ...
            const cacheTtlSeconds = 60;
            ctx.waitUntil(env.KV_CACHE.put(cacheKey, responsePayloadString, { expirationTtl: cacheTtlSeconds }).catch(err => console.error(`[Cache] KV put 失败:`, err)));
            // ... (返回响应) ...
            return new Response(responsePayloadString, { headers: { 'Content-Type': 'application/json', 'X-Cache-Status': 'miss' } });
        }
    } catch (dbOrKvError) {
        console.error(`[/images Handler] 处理 KV 或 D1 时出错:`, dbOrKvError);
        throw new StatusError(500, "处理图片请求时发生内部错误。"); // itty-router 推荐抛出 StatusError
    }
}
