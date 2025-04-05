// ~/imgN/api-worker/src/routes.ts (修正 D1 错误日志)
import { IRequest, StatusError } from 'itty-router';
import { Env } from './types';
import { DurableObjectStub, RequestInit, ExecutionContext } from '@cloudflare/workers-types';

// --- Durable Object Singleton Access ---
const COORDINATOR_DO_NAME = "sync-coordinator-singleton";

function getCoordinatorStub(env: Env): DurableObjectStub {
    try {
        if (!env.SYNC_COORDINATOR_DO) {
            throw new Error("SYNC_COORDINATOR_DO binding is not configured.");
        }
        const doNamespace = env.SYNC_COORDINATOR_DO;
        const doId = doNamespace.idFromName(COORDINATOR_DO_NAME);
        return doNamespace.get(doId);
    } catch (e: any) {
        console.error("[API Routes] Failed to get Coordinator DO Stub:", e);
        throw new StatusError(500, `Durable Object binding error: ${e.message}`);
    }
}

async function forwardToCoordinatorWithPath(request: IRequest, env: Env, targetPath: string): Promise<Response> {
    const stub = getCoordinatorStub(env);
    const originalUrl = new URL(request.url);
    const targetUrl = new URL(originalUrl);
    targetUrl.pathname = targetPath;
    console.log(`[API Routes] Rewriting path from ${originalUrl.pathname} to ${targetUrl.pathname} for DO forwarding`);
    const forwardRequest = new Request(targetUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: request.redirect
    });
    console.log(`[API Routes] Forwarding ${forwardRequest.method} ${forwardRequest.url} to DO ${COORDINATOR_DO_NAME}`);
    return stub.fetch(forwardRequest);
}

// --- Route Handlers ---

export async function handleStartSync(request: IRequest, env: Env): Promise<Response> {
    return forwardToCoordinatorWithPath(request, env, '/start');
}
export async function handleStopSync(request: IRequest, env: Env): Promise<Response> {
    return forwardToCoordinatorWithPath(request, env, '/stop');
}
export async function handleStatus(request: IRequest, env: Env): Promise<Response> {
    return forwardToCoordinatorWithPath(request, env, '/status');
}
export async function handleReport(request: IRequest, env: Env): Promise<Response> {
    return forwardToCoordinatorWithPath(request, env, '/report');
}
export async function handleReset(request: IRequest, env: Env): Promise<Response> {
    return forwardToCoordinatorWithPath(request, env, '/reset');
}
export async function handleHealth(request: IRequest, env: Env): Promise<Response> {
    const html = `<!DOCTYPE html><body><h1>imgn-api-worker is running!</h1><p>Time: ${new Date().toISOString()}</p></body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// Handling /images request (Includes KV caching logic)
export async function handleGetImages(request: IRequest, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const getQueryParam = (param: string | string[] | undefined): string => {
        if (Array.isArray(param)) { return param[0] || ''; }
        return param || '';
    };

    const pageParam = getQueryParam(request.query?.page);
    const limitParam = getQueryParam(request.query?.limit);
    const page = parseInt(pageParam, 10);
    const limit = parseInt(limitParam, 10);
    const pageNum = Math.max(1, isNaN(page) ? 1 : page);
    const limitNum = Math.min(50, Math.max(1, isNaN(limit) ? 10 : limit));

    const cacheKey = `images_p${pageNum}_l${limitNum}`;
    console.log(`[Cache] Checking Key: ${cacheKey}`);

    if (!env.KV_CACHE) {
        console.error("[/images Handler] KV_CACHE binding is missing.");
        throw new StatusError(500, "Configuration error: KV Cache service is not available.");
    }
    if (!env.DB) {
        console.error("[/images Handler] DB binding is missing.");
        throw new StatusError(500, "Configuration error: Database service is not available.");
    }

    try {
        const cachedData = await env.KV_CACHE.get(cacheKey, "text");
        if (cachedData !== null) {
            console.log(`[Cache] Hit Key: ${cacheKey}`);
            return new Response(cachedData, {
                headers: { 'Content-Type': 'application/json', 'X-Cache-Status': 'hit', 'Access-Control-Allow-Origin': '*' }
            });
        }

        console.log(`[Cache] Miss Key: ${cacheKey}. Querying D1...`);
        const offset = (pageNum - 1) * limitNum;

        const countStmt = env.DB.prepare('SELECT COUNT(*) as total FROM img3_metadata;');
        const dataStmt = env.DB.prepare(`
            SELECT
                id, created_at_api, updated_at_api, width, height,
                description, alt_description, author_details, photo_links,
                location_details, tags_data
            FROM img3_metadata
            ORDER BY created_at_api DESC
            LIMIT ?1 OFFSET ?2;
        `).bind(limitNum, offset);

        const [countResult, dataResult] = await Promise.all([
            countStmt.first<{ total: number }>(),
            dataStmt.all()
        ]);

        if (!dataResult.success) {
            // --- 修正日志记录 ---
            // 移除对 dataResult.cause 的访问
            console.error(`D1 Query failed: ${dataResult.error}`); // Line 124 (修正后)
            // --- 结束日志记录修正 ---
            throw new Error(dataResult.error ?? "Database query failed");
        }

        const totalImages = countResult?.total ?? 0;
        const totalPages = Math.ceil(totalImages / limitNum);

        const images = (dataResult.results ?? []).map((row: any) => {
            try {
                return {
                    id: row.id,
                    created_at_api: row.created_at_api,
                    updated_at_api: row.updated_at_api,
                    width: row.width,
                    height: row.height,
                    description: row.description,
                    alt_description: row.alt_description,
                    author_details: row.author_details ? JSON.parse(row.author_details) : null,
                    photo_links: row.photo_links ? JSON.parse(row.photo_links) : null,
                    location_details: row.location_details ? JSON.parse(row.location_details) : null,
                    tags_data: row.tags_data ? JSON.parse(row.tags_data) : null
                };
            } catch (parseError) {
                console.warn(`Failed to parse JSON for row ID ${row.id}:`, parseError);
                return { id: row.id, width: row.width, height: row.height };
            }
        });

        const responsePayload = {
            success: true,
            data: { images, page: pageNum, limit: limitNum, totalImages, totalPages },
            message: "Images retrieved successfully"
        };
        const responsePayloadString = JSON.stringify(responsePayload);

        const cacheTtlSeconds = 60;
        ctx.waitUntil(
            env.KV_CACHE.put(cacheKey, responsePayloadString, { expirationTtl: cacheTtlSeconds })
                .catch(err => console.error('[Cache] KV put failed:', err))
        );

        return new Response(responsePayloadString, {
            headers: { 'Content-Type': 'application/json', 'X-Cache-Status': 'miss', 'Access-Control-Allow-Origin': '*' }
        });

    } catch (error) {
        console.error('[/images Handler] Error:', error);
        const message = error instanceof StatusError ? error.message : (error instanceof Error ? error.message : "An internal error occurred.");
        const finalMessage = message.includes("D1_ERROR:") ? message : "An internal server error occurred while fetching images.";
        const status = error instanceof StatusError ? error.status : 500;

        const errorResponse = { success: false, error: finalMessage, data: null };
        return new Response(JSON.stringify(errorResponse), {
            status: status,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}