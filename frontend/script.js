// ~/imgN/frontend/script.js (修正版 - 移除多余的 JSON.parse)

// --- 配置 ---
const API_BASE_URL = `https://imgn-api-worker.53.workers.dev`;
const IMAGES_API_URL = `${API_BASE_URL}/images`;
const START_SYNC_URL = `${API_BASE_URL}/start-sync`;
const STOP_SYNC_URL = `${API_BASE_URL}/stop-sync`;
const STATUS_URL = `${API_BASE_URL}/sync-status`;
const STATUS_POLL_INTERVAL = 5000;
const IMAGES_PER_PAGE = 10;
// !!! 请确保这里的 R2 公开访问 URL 是正确的 !!!
const R2_PUBLIC_URL_BASE = 'https://pub-61b373cf3f6e4863a70b53ca5e61dc53.r2.dev';

// --- DOM 元素获取 ---
const imageTableBody = document.getElementById('image-table-body');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const statusDisplay = document.getElementById('statusDisplay');
const actionMessage = document.getElementById('actionMessage');
const prevButton = document.getElementById('prevButton');
const nextButton = document.getElementById('nextButton');
const pageInfo = document.getElementById('pageInfo');
const prevButtonBottom = document.getElementById('prevButtonBottom');
const nextButtonBottom = document.getElementById('nextButtonBottom');
const pageInfoBottom = document.getElementById('pageInfoBottom');

// --- 状态变量 ---
let statusIntervalId = null;
let currentPage = 1;
let totalPages = 1;
let totalImages = 0;
let isLoadingImages = false;

// --- R2 Key 处理辅助函数 ---
/** 清理 Tag 标题用于 R2 Key */
function sanitizeForR2KeyJs(tagName) {
    if (!tagName) return '';
    // 修正：JS 中没有直接的 \p{L}\p{N}，简化为 a-z0-9_-
    // 如果需要更复杂的 Unicode 支持，需要引入库或更复杂的正则
    const sanitized = tagName.toLowerCase().replace(/[\s+]+/g, '_').replace(/[^a-z0-9_-]/g, '').substring(0, 50);
    if (!sanitized || /^[_ -]+$/.test(sanitized)) { return ''; }
    return sanitized;
}
/** 从 tags_data 对象获取 R2 文件夹名 */
function getFolderNameFromTagsJs(tagsData) { // 现在接收的是对象或 null
    const defaultFolder = 'uncategorized';
    // 直接检查 tagsData 是否为数组
    if (!Array.isArray(tagsData) || tagsData.length === 0) {
        // console.log("[getFolderNameFromTagsJs] tags_data 不是有效数组或为空");
        return defaultFolder;
    }
    // 假设 tagsData 是一个字符串数组 (根据 API Worker 返回的 tags_data 定义)
    for (const tagTitle of tagsData) {
        const sanitized = sanitizeForR2KeyJs(tagTitle);
        if (sanitized) {
            // console.log(`[getFolderNameFromTagsJs] 使用 tag: ${tagTitle} -> ${sanitized}`);
            return sanitized;
        }
    }
    // console.log("[getFolderNameFromTagsJs] 未找到合适的 tag，使用默认值");
    return defaultFolder;
}

// --- 其他辅助函数 ---

/** 显示操作反馈信息 */
function showActionMessage(message, isError = false) {
    if (!actionMessage) return;
    actionMessage.textContent = message;
    actionMessage.className = isError ? 'action-message error' : 'action-message';
    // 清除消息的 Timeout
    if (actionMessage.timeoutId) {
        clearTimeout(actionMessage.timeoutId);
    }
    actionMessage.timeoutId = setTimeout(() => {
        // 检查是否还是当前的消息，避免清除后续消息
        if (actionMessage.textContent === message) {
            actionMessage.textContent = '';
            actionMessage.className = 'action-message';
        }
    }, 4000);
}


/** 处理点击 "Start/Stop" 按钮 */
async function handleSyncAction(url, button) {
    if (!button || button.disabled) return;

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '处理中...';

    showActionMessage('正在发送请求...', false);
    try {
        const response = await fetch(url, { method: 'POST' });
        let result = { success: response.ok, message: `HTTP ${response.status}: ${response.statusText}` }; // Provide default message
        try {
            // 只有在响应 OK 时才尝试解析 JSON，否则使用状态文本
            if (response.ok) {
                result = await response.json();
            }
        } catch (e) {
            console.warn("Response body is not JSON or parsing failed, using status code/text.", e);
            // 如果 JSON 解析失败，保留之前的 result 状态
        }

        if (response.ok && result.success !== false) { // 检查 success !== false 以处理 API 可能返回 {success: true} 的情况
            showActionMessage(result.message || '操作成功！', false);
            setTimeout(fetchStatus, 100); // 稍微延迟后获取最新状态
        } else {
            // 抛出错误，使用 API 返回的 message 或默认 HTTP 状态信息
            throw new Error(result.message || `请求失败: ${response.status}`);
        }
    } catch (error) {
        console.error('执行同步操作时出错:', url, error);
        showActionMessage(`错误: ${error.message || '未知错误'}`, true);
        // 即使操作失败，也应该刷新状态以反映可能的错误状态
        fetchStatus();
    } finally {
        button.textContent = originalText;
        // 按钮的最终状态由 fetchStatus 根据 API 返回的状态决定，这里不再直接启用
        // fetchStatus(); // 已经在 catch 和成功逻辑后调用或安排调用
    }
}


/** 获取并显示同步状态 */
async function fetchStatus() {
    if (!statusDisplay) return;
    let currentStatus = 'unknown'; // 默认值

    try {
        const response = await fetch(STATUS_URL);
        // 检查网络或基本 HTTP 错误
        if (!response.ok) {
            // 对于 4xx/5xx 错误，尝试读取 body 看是否有 JSON 错误信息
            let errorMsg = `HTTP 错误! 状态: ${response.status}`;
            try {
                const errorResult = await response.json();
                if (errorResult && errorResult.error) {
                    errorMsg = errorResult.error;
                }
            } catch (e) { /* Ignore if body isn't JSON */ }
            throw new Error(errorMsg);
        }
        // --- 响应 OK ---
        const result = await response.json();
        if (result.success && result.data) {
            currentStatus = result.data.status || '未知';
            const page = result.data.lastProcessedPage ?? 'N/A'; // 使用 ?? 处理 null/undefined
            const totalPagesApi = result.data.totalPages ?? '?'; // 总页数可能未知
            const lastRunStart = result.data.lastRunStart ? new Date(result.data.lastRunStart).toLocaleString() : 'N/A';
            const lastError = result.data.lastError;

            let statusText = `状态: ${currentStatus} (上次处理页: ${page} / ${totalPagesApi})`;
            // if (lastRunStart !== 'N/A') { statusText += ` | 开始于: ${lastRunStart}`; } // 可以选择性显示

            if (currentStatus === 'error' && lastError) {
                // 对错误信息做截断，避免过长
                statusText += ` - 错误: ${String(lastError).substring(0, 100)}${String(lastError).length > 100 ? '...' : ''}`;
            }
            statusDisplay.textContent = statusText;
        } else {
            // API 返回 { success: false } 或数据结构不对
            throw new Error(result.error || '无法解析状态响应');
        }
    } catch (error) {
        console.error('获取状态时出错:', error);
        statusDisplay.textContent = `状态: 获取错误 (${error.message})`;
        // 获取状态出错时，启用按钮允许重试，避免卡死
        if (startButton) startButton.disabled = false;
        if (stopButton) stopButton.disabled = false;
        return; // 提前退出，不执行下面的按钮状态更新
    }
    // --- 根据获取到的真实状态控制按钮 ---
    const isRunning = (currentStatus === 'running');
    const isStopping = (currentStatus === 'stopping');
    // 只有在 idle 或 error 状态下才能开始
    if (startButton) startButton.disabled = isRunning || isStopping;
    // 只有在 running 状态下才能停止
    if (stopButton) stopButton.disabled = !isRunning;
}


/** 创建图片信息表格行 (包含详细日志) */
function createImageInfoRow(imageData) {
    const photoId = imageData?.id || 'ID_缺失';
    console.log(`[createImageInfoRow] 开始处理 ID: ${photoId}`, { data: imageData });

    const tr = document.createElement('tr');
    let authorName = '未知作者'; let authorLink = '#';
    let originalLink = '#'; let locationDisplay = '-';
    let tagsDisplay = '-'; // 用于显示所有 tag
    // let category = '-'; // 不再单独提取 category，直接用 getFolderNameFromTagsJs
    let r2ImageUrl = null;

    // --- 解析 author_details (移除 JSON.parse) ---
    if (imageData.author_details && typeof imageData.author_details === 'object') {
        const author = imageData.author_details; // 直接使用对象
        authorName = author.name || authorName;
        authorLink = author.links?.html || authorLink;
        console.log(`[createImageInfoRow][${photoId}] 使用 author_details 对象: name=${authorName}`);
    } else {
        console.log(`[createImageInfoRow][${photoId}] author_details 不存在或不是对象`);
        if (imageData.author_details) { // 如果存在但不是对象，记录错误
            console.warn(`[createImageInfoRow][${photoId}] author_details 格式错误，期望对象但收到: ${typeof imageData.author_details}`);
        }
    }

    // --- 解析 photo_links (移除 JSON.parse) ---
    if (imageData.photo_links && typeof imageData.photo_links === 'object') {
        const links = imageData.photo_links; // 直接使用对象
        originalLink = links.html || '#'; // Unsplash 页面链接
        // 可以考虑使用 links.download 作为下载链接，如果需要的话
        console.log(`[createImageInfoRow][${photoId}] 使用 photo_links 对象: html=${originalLink}`);
    } else {
        console.log(`[createImageInfoRow][${photoId}] photo_links 不存在或不是对象`);
        if (imageData.photo_links) {
            console.warn(`[createImageInfoRow][${photoId}] photo_links 格式错误，期望对象但收到: ${typeof imageData.photo_links}`);
        }
    }


    // --- 解析 location_details (移除 JSON.parse) ---
    if (imageData.location_details && typeof imageData.location_details === 'object') {
        const loc = imageData.location_details; // 直接使用对象
        locationDisplay = [loc.city, loc.country].filter(Boolean).join(', ') || loc.name || '-';
        if (locationDisplay.length > 50) locationDisplay = locationDisplay.substring(0, 50) + '...';
        console.log(`[createImageInfoRow][${photoId}] 使用 location_details 对象: display=${locationDisplay}`);
    } else {
        console.log(`[createImageInfoRow][${photoId}] location_details 不存在或不是对象`);
        if (imageData.location_details) {
            console.warn(`[createImageInfoRow][${photoId}] location_details 格式错误，期望对象但收到: ${typeof imageData.location_details}`);
        }
    }

    // --- 解析 tags_data (移除 JSON.parse) ---
    if (Array.isArray(imageData.tags_data) && imageData.tags_data.length > 0) {
        const tagsArray = imageData.tags_data; // 直接使用数组
        // 假设 API 返回的是字符串数组 ['tag1', 'tag2', ...]
        tagsDisplay = tagsArray.join(' ');
        console.log(`[createImageInfoRow][${photoId}] 使用 tags_data 数组: display=${tagsDisplay}`);
    } else {
        console.log(`[createImageInfoRow][${photoId}] tags_data 不是有效数组或为空`);
        tagsDisplay = '-';
        if (imageData.tags_data && !Array.isArray(imageData.tags_data)) { // 如果存在但不是数组
            console.warn(`[createImageInfoRow][${photoId}] tags_data 格式错误，期望数组但收到: ${typeof imageData.tags_data}`);
        }
    }

    // 构造 R2 URL (用于 ID 链接 和 图片预览)
    let r2PublicUrlForImage = ''; // 用于 img src
    let folderNameForR2 = 'uncategorized'; // 默认文件夹
    if (photoId !== 'ID_缺失' && R2_PUBLIC_URL_BASE && R2_PUBLIC_URL_BASE !== 'https://<你的R2公共URL>') {
        folderNameForR2 = getFolderNameFromTagsJs(imageData.tags_data); // 使用已解析的 tags_data (对象)
        const r2Key = `${folderNameForR2}/${photoId}.jpg`; // 假设是 .jpg 后缀
        r2PublicUrlForImage = `${R2_PUBLIC_URL_BASE.replace(/\/$/, '')}/${r2Key}`;
        // 如果原始 Unsplash 链接无效，使用 R2 链接作为备用
        if (originalLink === '#') { originalLink = r2PublicUrlForImage; }
        console.log(`[createImageInfoRow][${photoId}] 构造 R2 URL (供预览/链接使用): ${r2PublicUrlForImage}`);
    } else {
        console.warn(`[createImageInfoRow][${photoId}] 无法构造 R2 URL (ID 或 Base URL 配置问题)`);
        originalLink = '#'; // 无法构造 R2 URL 时，链接保持无效
    }

    // 格式化时间
    const timeStr = imageData.created_at_api || imageData.updated_at_api;
    let displayTime = '-';
    if (timeStr) { try { displayTime = new Date(timeStr).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { } }

    // 准备其他列数据
    const displaySize = (imageData.width && imageData.height) ? `${imageData.width} x ${imageData.height}` : '-'; // 使用 API 返回的 width/height
    const description = imageData.description || imageData.alt_description || '-';

    // 构建表格行 HTML (添加 R2 图片预览)
    tr.innerHTML = `
        <td><img src="${r2PublicUrlForImage || 'placeholder.png'}" alt="预览 ${photoId}" loading="lazy" class="thumbnail" onerror="this.style.display='none'"></td>
        <td><a href="${originalLink}" target="_blank" title="查看来源">${photoId}</a></td>
        <td>${displaySize}</td>
        <td>${locationDisplay}</td>
        <td>${displayTime}</td>
        <td>${tagsDisplay}</td>
        <td title="${description}">${description.substring(0, 100)}${description.length > 100 ? '...' : ''}</td>
        <td><a href="${authorLink}" target="_blank">${authorName}</a></td>
    `; // 添加了作者列

    console.log(`[createImageInfoRow][${photoId}] 成功创建并返回 TR 元素。`);
    return tr;
}

/** 加载并显示图片信息到表格 (包含详细日志) */
async function loadImages(page = 1) {
    if (!imageTableBody) { console.error("无法找到 #image-table-body 元素!"); return; }
    if (isLoadingImages) { console.log("[loadImages] 正在加载中，跳过此次调用"); return; }

    isLoadingImages = true;
    imageTableBody.innerHTML = `<tr><td colspan="8" class="loading-cell">正在加载信息...</td></tr>`; // 列数增加到 8
    currentPage = page; // 更新当前页状态
    updatePaginationUI(); // 更新分页 UI（禁用按钮）

    try {
        const url = `${IMAGES_API_URL}?page=${currentPage}&limit=${IMAGES_PER_PAGE}`;
        console.log(`[loadImages] 从 API 获取信息: ${url}`);
        const response = await fetch(url);
        if (!response.ok) {
            // 尝试解析 JSON 错误体
            let errorMsg = `HTTP 错误! 状态: ${response.status}`;
            try {
                const errorData = await response.json();
                if (errorData && errorData.error) {
                    errorMsg = errorData.error;
                }
            } catch (e) { /* 忽略 body 解析错误 */ }
            throw new Error(errorMsg);
        }
        const jsonData = await response.json();

        console.log("[loadImages] 接收到 API 数据:", jsonData);

        if (jsonData.success && jsonData.data) { // 检查 data 对象本身
            imageTableBody.innerHTML = ''; // 清空加载提示
            totalImages = jsonData.data.totalImages || 0;
            totalPages = jsonData.data.totalPages || 1;
            const imagesToRender = jsonData.data.images; // 获取图片数组

            if (imagesToRender && imagesToRender.length > 0) {
                console.log(`[loadImages] 准备渲染 ${imagesToRender.length} 行数据...`);
                imagesToRender.forEach((image) => { // 不需要 index
                    const tableRow = createImageInfoRow(image);
                    if (tableRow) {
                        imageTableBody.appendChild(tableRow);
                    } else {
                        console.warn(`[loadImages] 未能为图片 ID 创建表格行: ${image?.id}`);
                    }
                });
                console.log(`[loadImages] ${imagesToRender.length} 行数据渲染循环结束。`);
            } else {
                const emptyMsg = (currentPage === 1) ? '数据库中还没有图片信息。请尝试启动同步。' : '当前页没有图片信息。';
                imageTableBody.innerHTML = `<tr><td colspan="8" class="loading-cell">${emptyMsg}</td></tr>`; // 列数增加到 8
            }
        } else {
            // API 返回 success: false 或 data 缺失
            console.error("[loadImages] API 返回失败或数据结构不正确:", jsonData);
            throw new Error(jsonData.error || '加载信息失败 (API 数据格式错误)。'); // 使用 API 返回的 error
        }
    } catch (error) {
        console.error('[loadImages] 加载信息过程中出错:', error);
        if (imageTableBody) { imageTableBody.innerHTML = `<tr><td colspan="8" class="loading-cell" style="color: red;">加载信息出错: ${error.message}</td></tr>`; } // 列数增加到 8
        totalPages = currentPage; // 假设出错时无法知道总页数，停留在当前页
        totalImages = 0; // 总数未知
    } finally {
        isLoadingImages = false;
        updatePaginationUI(); // 根据最终状态更新分页 UI（启用按钮等）
        console.log("[loadImages] 加载流程结束.");
    }
}

// 更新分页 UI (根据状态变量更新按钮和信息)
function updatePaginationUI() {
    const pageInfoText = `第 ${currentPage} / ${totalPages} 页 (共 ${totalImages} 条记录)`;
    if (pageInfo) pageInfo.textContent = pageInfoText;
    if (pageInfoBottom) pageInfoBottom.textContent = pageInfoText;

    const disablePrev = isLoadingImages || currentPage <= 1;
    const disableNext = isLoadingImages || currentPage >= totalPages || totalPages <= 1; // 如果只有一页或未知页数也禁用下一页

    if (prevButton) prevButton.disabled = disablePrev;
    if (prevButtonBottom) prevButtonBottom.disabled = disablePrev;
    if (nextButton) nextButton.disabled = disableNext;
    if (nextButtonBottom) nextButtonBottom.disabled = disableNext;
}


// 分页按钮处理
function handlePrevPage() {
    if (!isLoadingImages && currentPage > 1) {
        loadImages(currentPage - 1);
    }
}
function handleNextPage() {
    if (!isLoadingImages && currentPage < totalPages) {
        loadImages(currentPage + 1);
    }
}

// --- 初始化函数 ---
function init() {
    // 检查所有需要的 DOM 元素是否存在
    if (!startButton || !stopButton || !prevButton || !nextButton || !pageInfo || !imageTableBody || !statusDisplay || !actionMessage || !prevButtonBottom || !nextButtonBottom || !pageInfoBottom) {
        console.error("DOM 元素缺失，部分功能可能无法初始化！请检查 HTML 结构和 ID 是否匹配。");
        // 可以选择不完全阻止初始化，但要意识到某些功能会失效
        // return;
    }

    // 绑定事件监听器 (即使元素可能不存在，也尝试绑定，浏览器会忽略失败的绑定)
    if (startButton) startButton.addEventListener('click', () => handleSyncAction(START_SYNC_URL, startButton));
    if (stopButton) stopButton.addEventListener('click', () => handleSyncAction(STOP_SYNC_URL, stopButton));
    if (prevButton) prevButton.addEventListener('click', handlePrevPage);
    if (nextButton) nextButton.addEventListener('click', handleNextPage);
    if (prevButtonBottom) prevButtonBottom.addEventListener('click', handlePrevPage);
    if (nextButtonBottom) nextButtonBottom.addEventListener('click', handleNextPage);

    // 初始加载
    loadImages(currentPage); // 加载第一页
    fetchStatus(); // 获取初始状态

    // 启动状态轮询
    if (statusIntervalId) clearInterval(statusIntervalId); // 清除旧的轮询（如果有）
    statusIntervalId = setInterval(fetchStatus, STATUS_POLL_INTERVAL);
    console.log(`状态轮询已启动.`);
}

// --- 脚本入口 ---
if (document.readyState === 'loading') {
    // 等待 DOM 完全加载后再执行初始化
    document.addEventListener('DOMContentLoaded', init);
} else {
    // 如果 DOM 已加载，则立即执行初始化
    init();
}