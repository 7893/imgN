// ~/imgN/api-worker/src/routes.ts (修正 forwardToDo)
import { IRequest, StatusError } from 'itty-router';
import { ApiWorkerEnv as Env } from './types'; // <-- 明确导入 ApiWorkerEnv
import { DurableObjectStub, RequestInit, ExecutionContext } from '@cloudflare/workers-types'; // 导入 RequestInit, ExecutionContext

// 获取 DO Stub (保持不变)
function getDoStub(env: Env): DurableObjectStub { /* ... */ try { const ns = env.SYNC_COORDINATOR_DO; const id = ns.idFromName("sync-coordinator-singleton"); return ns.get(id); } catch (e: any) { throw new StatusError(500, "DO 绑定错误。"); } }

/**
 * 转发请求到 Durable Object (修正版 - 使用 RequestInit)
 * @param request 原始请求 (itty-router 的 IRequest 或标准 Request)
 * @param env 环境绑定
 * @param internalPath 要转发到的 DO 内部路径 (例如 '/start')
 * @returns Promise<Response> 从 DO 返回的响应
 */
async function forwardToDo(request: IRequest | Request, env: Env, internalPath: string): Promise<Response> {
    const doStub = getDoStub(env);
    // DO 的 fetch 需要标准的 URL，内部路径通过 pathname 传递
    const doUrl = new URL(`https://do-internal${internalPath}`); // 使用占位符主机名

    console.log(`[API Route] 转发 ${request.method} ${request.url} (mapped to ${internalPath}) 到 DO...`);

    // 构造 RequestInit 对象
    const doRequestInit: RequestInit = {
        method: request.method,
        headers: request.headers, // 直接传递原始 Headers 通常可以
    };

    // 仅在有 Body 且是相关方法时克隆并传递 Body
    // 需要处理 itty-router IRequest 和标准 Request 的差异
    if (request.body && ['POST', 'PUT', 'PATCH'].includes(request.method)) {
        try {
            // 尝试将 body 读取为 ArrayBuffer (更通用)
            doRequestInit.body = await (request as any).arrayBuffer();
            // 如果你知道 body 总是 JSON，可以:
            // const bodyJson = await (request as any).json();
            // doRequestInit.body = JSON.stringify(bodyJson);
            // doRequestInit.headers = new Headers(request.headers); // 创建新 Headers
            // doRequestInit.headers.set('Content-Type', 'application/json'); // 确保 Content-Type
        } catch (e) {
            console.error("准备 DO 请求 Body 时出错:", e);
            throw new StatusError(400, "无法处理请求体以转发。");
        }
    }

    // 使用 URL 字符串和 RequestInit 调用 DO 的 fetch
    return doStub.fetch(doUrl.toString(), doRequestInit);
}

// --- 路由处理函数 (调用修正后的 forwardToDo) ---
export async function handleStartSync(request: IRequest, env: Env): Promise<Response> { return forwardToDo(request, env, '/start'); }
export async function handleStopSync(request: IRequest, env: Env): Promise<Response> { return forwardToDo(request, env, '/stop'); }
export async function handleStatus(request: IRequest, env: Env): Promise<Response> { return forwardToDo(request, env, '/status'); }
export async function handleReport(request: IRequest, env: Env): Promise<Response> { return forwardToDo(request, env, '/report'); }
export async function handleReset(request: IRequest, env: Env): Promise<Response> { return forwardToDo(request, env, '/reset'); }
export async function handleHealth(request: IRequest, env: Env): Promise<Response> { /* ... (保持不变) ... */ }

// handleGetImages (保持不变，但需要导入 ExecutionContext)
export async function handleGetImages(request: IRequest, env: Env, ctx: ExecutionContext): Promise<Response> {
    // ... (获取参数逻辑, KV 缓存逻辑, D1 查询逻辑 保持不变) ...
    // 确保正确导入和使用了 env (ApiWorkerEnv) 和 ctx
    // 返回 new Response(...)
}