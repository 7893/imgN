// ~/imgN/api-worker/src/routes.ts (Improved Version)
import { IRequest, StatusError } from 'itty-router';
import { Env } from './types'; // Assuming Env includes SYNC_COORDINATOR_DO, DB, KV_CACHE bindings
import { DurableObjectStub, RequestInit, ExecutionContext } from '@cloudflare/workers-types';

// --- Durable Object Singleton Access ---
// Define a consistent name for the singleton Durable Object instance
const COORDINATOR_DO_NAME = "sync-coordinator-singleton";

/**
 * Gets the singleton SyncCoordinatorDO stub using a predefined name.
 * @param env - The worker environment containing the DO binding.
 * @returns The DurableObjectStub for the coordinator singleton.
 * @throws StatusError if the DO binding is missing or invalid.
 */
function getCoordinatorStub(env: Env): DurableObjectStub {
    try {
        // Ensure the necessary DO binding exists in the environment
        if (!env.SYNC_COORDINATOR_DO) {
            throw new Error("SYNC_COORDINATOR_DO binding is not configured in wrangler.toml or Cloudflare dashboard.");
        }
        const doNamespace = env.SYNC_COORDINATOR_DO;
        // Get the ID for our singleton instance using its predefined name
        const doId = doNamespace.idFromName(COORDINATOR_DO_NAME);
        // Get the stub (a reference to the DO instance)
        return doNamespace.get(doId);
    } catch (e: any) {
        console.error("[API Routes] Failed to get Coordinator DO Stub:", e);
        // Throw a specific error that the main fetch handler can catch and return appropriately
        throw new StatusError(500, `Durable Object binding configuration error or access failure: ${e.message}`);
    }
}

/**
 * Helper function to forward a request to the singleton DO,
 * rewriting the URL path to what the DO expects.
 * @param request The original incoming request from the client.
 * @param env The worker environment.
 * @param targetPath The path the DO's internal router expects (e.g., '/start', '/status').
 * @returns The Response promise from the Durable Object.
 */
async function forwardToCoordinatorWithPath(request: IRequest, env: Env, targetPath: string): Promise<Response> {
    const stub = getCoordinatorStub(env); // Get the singleton stub

    // Create a new URL based on the original, but change the pathname
    const originalUrl = new URL(request.url);
    const targetUrl = new URL(originalUrl);
    targetUrl.pathname = targetPath; // Set the path the DO expects

    console.log(`[API Routes] Rewriting path from ${originalUrl.pathname} to ${targetUrl.pathname} for DO forwarding`);

    // Create a new Request object with the modified URL but retaining original method, headers, body, etc.
    // This is necessary because the Request object's URL is immutable.
    const forwardRequest = new Request(targetUrl.toString(), {
        method: request.method,
        headers: request.headers, // Pass original headers
        body: request.body,       // Pass original body stream
        redirect: request.redirect // Preserve original redirect setting
    });

    console.log(`[API Routes] Forwarding ${forwardRequest.method} ${forwardRequest.url} to DO ${COORDINATOR_DO_NAME}`);
    // Send the modified request to the singleton DO instance
    return stub.fetch(forwardRequest);
}


// --- Route Handlers ---

// Handlers for controlling the sync process now use the helper to forward correctly
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
    // This endpoint is called by the sync-worker via Service Binding
    return forwardToCoordinatorWithPath(request, env, '/report');
}

export async function handleReset(request: IRequest, env: Env): Promise<Response> {
    return forwardToCoordinatorWithPath(request, env, '/reset');
}

// --- Other Handlers (Logic primarily unchanged, added binding checks and minor improvements) ---

export async function handleHealth(request: IRequest, env: Env): Promise<Response> {
    // Health check usually doesn't need to access external services, but confirms the worker is responding.
    const html = `<!DOCTYPE html><body><h1>imgn-api-worker is running!</h1><p>Time: ${new Date().toISOString()}</p></body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// Handling /images request (Includes KV caching logic)
export async function handleGetImages(request: IRequest, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Helper to safely get a single query parameter value
    const getQueryParam = (param: string | string[] | undefined): string => {
        if (Array.isArray(param)) {
            return param[0] || ''; // Take the first value if it's an array
        }
        return param || ''; // Return the value or empty string
    };

    // Validate and parse pagination parameters
    const pageParam = getQueryParam(request.query?.page);
    const limitParam = getQueryParam(request.query?.limit);
    const page = parseInt(pageParam, 10);
    const limit = parseInt(limitParam, 10);
    const pageNum = Math.max(1, isNaN(page) ? 1 : page); // Default to page 1 if invalid
    const limitNum = Math.min(50, Math.max(1, isNaN(limit) ? 10 : limit)); // Default limit 10, max 50

    const cacheKey = `images_p${pageNum}_l${limitNum}`;
    console.log(`[Cache] Checking Key: ${cacheKey}`);

    // --- Check for required bindings ---
    if (!env.KV_CACHE) {
        console.error("[/images Handler] KV_CACHE binding is missing.");
        // Throw StatusError so the main handler returns a proper 500 JSON response
        throw new StatusError(500, "Configuration error: KV Cache service is not available.");
    }
    if (!env.DB) {
        console.error("[/images Handler] DB binding is missing.");
        throw new StatusError(500, "Configuration error: Database service is not available.");
    }
    // --- End Binding Checks ---

    try {
        // 1. Check KV Cache
        const cachedData = await env.KV_CACHE.get(cacheKey, "text");
        if (cachedData !== null) {
            console.log(`[Cache] Hit Key: ${cacheKey}`);
            // Return cached response
            return new Response(cachedData, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Cache-Status': 'hit',
                    'Access-Control-Allow-Origin': '*' // Adjust CORS policy as needed
                }
            });
        }

        // 2. Cache Miss - Query D1 Database
        console.log(`[Cache] Miss Key: ${cacheKey}. Querying D1...`);
        const offset = (pageNum - 1) * limitNum;

        // Prepare D1 statements for total count and paginated data
        const countStmt = env.DB.prepare('SELECT COUNT(*) as total FROM img3_metadata;');
        // Select columns needed for the response structure below
        const dataStmt = env.DB.prepare(`
            SELECT
                id, created_at_api, updated_at_api, resolution, description,
                alt_description, author_details, photo_links, location_details, tags_data
            FROM img3_metadata
            ORDER BY created_at_api DESC
            LIMIT ?1 OFFSET ?2;
        `).bind(limitNum, offset);

        // Execute D1 queries in parallel
        const [countResult, dataResult] = await Promise.all([
            countStmt.first<{ total: number }>(),
            dataStmt.all() // Using .all() which includes success/error info
        ]);

        // Check D1 query success
        if (!dataResult.success) {
            console.error(`D1 Query failed: ${dataResult.error}`, dataResult.cause);
            throw new Error(`Database query failed: ${dataResult.error}`); // Throw generic error for security
        }

        const totalImages = countResult?.total ?? 0;
        const totalPages = Math.ceil(totalImages / limitNum);

        // 3. Map D1 results to API response format
        // This mapping assumes some fields in D1 are stored as JSON strings
        const images = (dataResult.results ?? []).map((row: any) => { // Using 'any' for brevity, define a DBRow type for better safety
            try {
                return {
                    id: row.id,
                    created_at_api: row.created_at_api,
                    updated_at_api: row.updated_at_api,
                    resolution: row.resolution,
                    description: row.description,
                    alt_description: row.alt_description,
                    // Safely parse JSON string fields from D1, defaulting to null if invalid or missing
                    author_details: row.author_details ? JSON.parse(row.author_details) : null,
                    photo_links: row.photo_links ? JSON.parse(row.photo_links) : null,
                    location_details: row.location_details ? JSON.parse(row.location_details) : null,
                    tags_data: row.tags_data ? JSON.parse(row.tags_data) : null
                };
            } catch (parseError) {
                console.warn(`Failed to parse JSON for row ID ${row.id}:`, parseError);
                // Return partially mapped data or null/undefined if critical fields failed
                return { id: row.id /* include other non-JSON fields */ };
            }
        });

        // 4. Construct the final API response payload
        const responsePayload = {
            success: true,
            data: {
                images,
                page: pageNum,
                limit: limitNum,
                totalImages,
                totalPages
            },
            message: "Images retrieved successfully"
        };
        const responsePayloadString = JSON.stringify(responsePayload);

        // 5. Asynchronously store the result in KV Cache for future requests
        const cacheTtlSeconds = 60; // Example: Cache for 1 minute
        ctx.waitUntil(
            env.KV_CACHE.put(cacheKey, responsePayloadString, {
                expirationTtl: cacheTtlSeconds
            }).catch(err => console.error('[Cache] KV put failed:', err)) // Log cache write errors but don't fail the request
        );

        // 6. Return the successful response (cache miss)
        return new Response(responsePayloadString, {
            headers: {
                'Content-Type': 'application/json',
                'X-Cache-Status': 'miss',
                'Access-Control-Allow-Origin': '*' // Adjust CORS policy as needed
            }
        });

    } catch (error) {
        // Handle errors during cache access, D1 query, or data processing
        console.error('[/images Handler] Error:', error);

        // Determine appropriate status code and message
        const message = error instanceof StatusError ? error.message : (error instanceof Error ? error.message : "An internal error occurred while processing the image request.");
        const status = error instanceof StatusError ? error.status : 500;

        const errorResponse = {
            success: false,
            error: message, // Provide a user-friendly error message
            data: null
        };
        // Return a JSON error response
        return new Response(JSON.stringify(errorResponse), {
            status: status,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*' // Adjust CORS policy as needed
            }
        });
    }
}