// ~/imgN/api-worker/src/types.ts
import { IRequest } from 'itty-router';
import {
    ExecutionContext,
    DurableObjectState,
    Queue,
    DurableObjectNamespace, // Added for Env
    KVNamespace,            // Added for Env
    D1Database              // Added for Env
} from '@cloudflare/workers-types';

// Define the environment bindings expected by the API Worker & DO
export interface Env {
    DB: D1Database;
    KV_CACHE: KVNamespace;
    SYNC_COORDINATOR_DO: DurableObjectNamespace;
    SYNC_TASK_QUEUE: Queue<QueueMessagePayload>; // Assuming DO needs to send messages too
    // Add any secrets if needed by API worker/DO directly
    // Example: SOME_API_KEY?: string;
}


// 队列消息载荷类型 (Used by DO to send, and potentially API worker if it reads queues)
export interface QueueMessagePayload {
    page: number;
    retryCount?: number;
    lastError?: string;
    timestamp?: number;
}

// 扩展请求类型 (From itty-router)
export interface ExtendedRequest extends IRequest {
    query: { [key: string]: string | undefined };
}

// API 错误类型
export class APIError extends Error {
    constructor(
        message: string,
        public status: number = 500,
        public code?: string
    ) {
        super(message);
        this.name = 'APIError';
    }
}

// 同步状态类型 (Used by the Durable Object)
export interface SyncState {
    syncStatus: 'idle' | 'running' | 'stopping' | 'error';
    lastProcessedPage: number;
    totalPages?: number;
    lastRunStart?: string;
    lastError?: string;
}

// 数据库模型类型 (Represents the *ideal* structure, maybe from source API like Unsplash)
// Note: This might differ from how data is stored flattened in D1 or returned by the /images API.
export interface ImageMetadata {
    id: string;
    created_at_api: string;
    updated_at_api: string;
    width: number;
    height: number;
    color: string;
    blur_hash: string;
    downloads?: number;
    likes?: number;
    description?: string | null;
    alt_description?: string | null;
    urls: {
        raw: string;
        full: string;
        regular: string;
        small: string;
        thumb: string;
    };
    user: {
        id: string;
        username: string;
        name: string;
    };
    location?: {
        city?: string;
        country?: string;
        position?: {
            latitude?: number;
            longitude?: number;
        };
    };
    exif?: {
        make?: string;
        model?: string;
        exposure_time?: string;
        aperture?: string;
        focal_length?: string;
        iso?: number;
    };
}

// DO 请求配置类型 (If needed, seems unused in provided snippets)
export interface DORequestInit extends RequestInit {
    method: string;
    headers: Headers;
    body?: BodyInit | null;
}

// 类型守卫 (Type Guard)
// TS2355 reported here (line 77), but the function looks correct. Check local code.
export function isSyncState(obj: unknown): obj is SyncState { // Line 77 starts here
    return obj !== null
        && typeof obj === 'object'
        && 'syncStatus' in obj // Check for a key property
        && typeof (obj as SyncState).lastProcessedPage === 'number'; // Check type of another key property
}

// 运行时类型检查 (Assertion Function) - Example
export function validateImageMetadata(data: unknown): asserts data is ImageMetadata {
    if (!data || typeof data !== 'object') {
        throw new APIError('Invalid image metadata structure: Not an object.', 400);
    }
    const img = data as Partial<ImageMetadata>; // Use Partial for checking optional fields
    if (!img.id || typeof img.id !== 'string') {
        throw new APIError('Missing or invalid image id (must be a string).', 400, 'INVALID_ID');
    }
    if (!img.urls || typeof img.urls !== 'object' || !img.urls.raw || typeof img.urls.raw !== 'string') {
        // Example: Check nested structure and types more thoroughly
        throw new APIError('Missing or invalid image URLs (must be an object with at least a raw URL string).', 400, 'INVALID_URLS');
    }
    // Add more specific checks for other required fields and their types
    if (typeof img.width !== 'number' || typeof img.height !== 'number') {
        throw new APIError('Image width and height must be numbers.', 400, 'INVALID_DIMENSIONS');
    }
    // ... etc.
}