// ~/imgN/frontend/script.js

// --- 配置 ---
const API_BASE_URL = `https://imgn-api-worker.53.workers.dev`;
const IMAGES_API_URL = `${API_BASE_URL}/images`;
const START_SYNC_URL = `${API_BASE_URL}/start-sync`;
const STOP_SYNC_URL = `${API_BASE_URL}/stop-sync`;
const STATUS_URL = `${API_BASE_URL}/sync-status`;
const STATUS_POLL_INTERVAL = 5000; // 状态轮询间隔 (毫秒)
const IMAGES_PER_PAGE = 30; // 每页图片数量

// *** 重要：请将这里的占位符替换为你真实的 R2 公开访问 URL ***
const R2_PUBLIC_URL_BASE = 'https://ed3e4f0448b71302675f2b436e5e8dd3.r2.cloudflarestorage.com/r2-imgn-20240402'; // 例如: 'https://pub-xxxxxxxx.r2.dev'

// --- DOM 元素获取 ---
const imageGrid = document.getElementById('image-grid');
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

// --- R2 Key 处理辅助函数 (JavaScript 版本) ---

/** 清理 Tag 标题用于 R2 Key */
function sanitizeForR2KeyJs(tagName) {
    if (!tagName) return '';
    const sanitized = tagName
        .toLowerCase()
        .replace(/[\s+]+/g, '_')
        .replace(/[^a-z0-9_-]/g, '') // 保留字母、数字、下划线、连字符
        .substring(0, 50);
    if (!sanitized || /^[_ -]+$/.test(sanitized)) { return ''; }
    return sanitized;
}

/** 从 tags_data JSON 字符串获取 R2 文件夹名 */
function getFolderNameFromTagsJs(tagsData) {
    const defaultFolder = 'uncategorized';
    let tags = [];
    if (tagsData) {
        try {
            // 假设 D1 中 tags_data 存储的是 ["title1", "title2", ...] 形式的 JSON 字符串
            tags = JSON.parse(tagsData);
        } catch (e) {
            console.error("Failed to parse tags_data:", tagsData, e);
            return defaultFolder;
        }
    }

    if (!Array.isArray(tags) || tags.length === 0) {
        return defaultFolder;
    }

    for (const tagTitle of tags) {
        const sanitized = sanitizeForR2KeyJs(tagTitle);
        if (sanitized) {
            return sanitized; // 使用第一个有效的 tag
        }
    }
    return defaultFolder; // 所有 tag 都无效则返回默认值
}

// --- 其他辅助函数 ---

/** 显示操作反馈信息 */
function showActionMessage(message, isError = false) {
    if (!actionMessage) return;
    actionMessage.textContent = message;
    actionMessage.className = isError ? 'action-message error' : 'action-message';
    setTimeout(() => {
        if (actionMessage.textContent === message) {
            actionMessage.textContent = '';
            actionMessage.className = 'action-message';
        }
    }, 4000);
}

/** 处理 Start/Stop 按钮点击 */
async function handleSyncAction(url, button) {
    if (!button || button.disabled) return; // 防止重复点击
    button.disabled = true;
    const otherButton = (button === startButton) ? stopButton : startButton;
    if (otherButton) otherButton.disabled = true; // 同时禁用另一个按钮

    showActionMessage('正在发送请求...', false);
    try {
        const response = await fetch(url, { method: 'POST' });
        let result = { success: response.ok, message: response.statusText };
        try { result = await response.json(); } catch (e) { /* Ignore if not JSON */ }

        if (response.ok && result.success) {
            showActionMessage(result.message || '操作成功！', false);
            // 等待一小段时间再获取状态，给后端一点处理时间
            setTimeout(fetchStatus, 500);
        } else { throw new Error(result.message || `请求失败: ${response.status}`); }
    } catch (error) {
        console.error('执行同步操作时出错:', url, error);
        showActionMessage(`错误: ${error.message}`, true);
        // 出错时也尝试刷新下状态
        fetchStatus();
    }
    // finally { // 不再 finally 中启用按钮，由 fetchStatus 根据状态决定
    //     button.disabled = false; 
    // } 
}

/** 获取并显示同步状态，并控制按钮可用性 */
async function fetchStatus() {
    if (!statusDisplay) return;
    try {
        const response = await fetch(STATUS_URL);
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        const result = await response.json();
        if (result.success && result.data) {
            const status = result.data.status || 'unknown';
            const page = result.data.lastProcessedPage || 0;
            const lastError = result.data.lastError;
            let statusText = `状态: ${status} (上次处理页: ${page})`;
            if (status === 'error' && lastError) { statusText += ` - 错误: ${lastError.substring(0, 100)}${lastError.length > 100 ? '...' : ''}`; } // 限制错误长度
            statusDisplay.textContent = statusText;

            // 控制按钮状态
            const isRunning = (status === 'running');
            const isStopping = (status === 'stopping');
            if (startButton) startButton.disabled = isRunning || isStopping; // 运行时或停止中不能开始
            if (stopButton) stopButton.disabled = !isRunning; // 只有运行时才能停止

        } else { throw new Error(result.message || 'Could not get status'); }
    } catch (error) {
        console.error('获取状态时出错:', error);
        statusDisplay.textContent = `状态: 获取错误`;
        // 出错时保守地禁用所有控制按钮
        if (startButton) startButton.disabled = true;
        if (stopButton) stopButton.disabled = true;
    }
}

/** 创建图片卡片 HTML (使用 R2 URL) */
function createImageCard(imageData) {
    const card = document.createElement('div');
    card.classList.add('image-card');
    let authorName = '未知作者';
    let authorLink = '#';
    let description = imageData.description || imageData.alt_description || '<i>无描述</i>';
    let r2ImageUrl = null; // 初始化 R2 URL
    const photoId = imageData.id;

    // --- 构造 R2 URL ---
    if (photoId && R2_PUBLIC_URL_BASE && R2_PUBLIC_URL_BASE !== 'https://<你的R2公共URL>') { // 增加检查，防止占位符被使用
        const folderName = getFolderNameFromTagsJs(imageData.tags_data);
        const r2Key = `${folderName}/${photoId}`;
        // 确保基础 URL 结尾没有斜杠，路径前没有斜杠
        r2ImageUrl = `${R2_PUBLIC_URL_BASE.replace(/\/$/, '')}/${r2Key}`;
    } else if (!R2_PUBLIC_URL_BASE || R2_PUBLIC_URL_BASE === 'https://<你的R2公共URL>') {
        console.warn("R2_PUBLIC_URL_BASE 未配置或未修改! 无法生成 R2 URL。");
    }
    // --- R2 URL 构造结束 ---

    // 解析作者信息
    try {
        if (imageData.author_details) {
            const author = JSON.parse(imageData.author_details);
            authorName = author?.name || authorName;
            authorLink = author?.links?.html || authorLink;
        }
    } catch (e) { console.error("解析作者 JSON 时出错:", e, imageData); }

    // 如果 R2 URL 无效，则不创建卡片
    if (!r2ImageUrl) {
        console.warn("无法构造有效的 R2 图片 URL:", photoId);
        return null;
    }

    // 获取图片原始链接（可选，用于点击图片本身）
    let originalLink = r2ImageUrl; // 默认点击也打开 R2 图片
    try {
        if (imageData.photo_links) {
            const links = JSON.parse(imageData.photo_links);
            originalLink = links?.html || originalLink; // 优先使用 Unsplash 页面链接
        }
    } catch (e) { /* ignore parsing error */ }

    card.innerHTML = `
        <a href="${originalLink}" target="_blank" rel="noopener noreferrer" title="View original source or full image"> 
			<img src="${r2ImageUrl}" alt="${imageData.alt_description || imageData.description || 'Image'}" loading="lazy">
		</a>
		<div class="image-info">
			<p class="description">${description}</p>
			<p class="author">作者: <a href="${authorLink}" target="_blank" rel="noopener noreferrer">${authorName}</a></p>
			<p class="likes">点赞: ${imageData.likes || 0}</p>
		</div>
	`;
    return card;
}

/** 加载并显示图片 (带分页) */
async function loadImages(page = 1) {
    if (!imageGrid || isLoadingImages) return;

    isLoadingImages = true;
    imageGrid.innerHTML = '<p>正在加载图片...</p>';
    // 更新分页 UI 为加载中状态
    updatePaginationUI();

    currentPage = page;

    try {
        const url = `${IMAGES_API_URL}?page=${currentPage}&limit=${IMAGES_PER_PAGE}`;
        console.log(`从 API 获取图片: ${url}`);
        const response = await fetch(url);
        if (!response.ok) { throw new Error(`HTTP 错误! 状态: ${response.status}`); }
        const jsonData = await response.json();
        console.log("接收到图片数据:", jsonData);

        if (jsonData.success && jsonData.data?.images) {
            imageGrid.innerHTML = '';
            totalImages = jsonData.data.totalImages || 0;
            totalPages = jsonData.data.totalPages || 1;
            const images = jsonData.data.images;

            if (images.length > 0) {
                images.forEach(image => {
                    const card = createImageCard(image);
                    if (card) { imageGrid.appendChild(card); }
                });
            } else {
                imageGrid.innerHTML = '<p>当前页没有图片。</p>';
                if (currentPage === 1) { imageGrid.innerHTML = '<p>图库中还没有图片。请尝试启动同步。</p>'; }
            }

            updatePaginationUI(); // 更新分页信息和按钮状态

        } else { throw new Error(jsonData.message || '加载图片失败。'); }

    } catch (error) {
        console.error('加载图片时出错:', error);
        if (imageGrid) { imageGrid.innerHTML = `<p style="color: red;">加载图片出错: ${error.message}</p>`; }
        totalPages = currentPage; // 出错时假设当前页是最后一页，防止无限点击下一页
        updatePaginationUI();
    } finally {
        isLoadingImages = false;
    }
}

/** 更新分页控件的 UI (显示总数并控制按钮) */
function updatePaginationUI() {
    const pageInfoText = `Page ${currentPage} / ${totalPages} (Total: ${totalImages} images)`;
    // 更新顶部和底部分页信息
    if (pageInfo) pageInfo.textContent = pageInfoText;
    if (pageInfoBottom) pageInfoBottom.textContent = pageInfoText;

    // 更新按钮状态（考虑 isLoadingImages）
    const disablePrev = isLoadingImages || currentPage <= 1;
    const disableNext = isLoadingImages || currentPage >= totalPages;

    if (prevButton) prevButton.disabled = disablePrev;
    if (prevButtonBottom) prevButtonBottom.disabled = disablePrev;
    if (nextButton) nextButton.disabled = disableNext;
    if (nextButtonBottom) nextButtonBottom.disabled = disableNext;
}

/** 处理点击上一页 */
function handlePrevPage() { if (!isLoadingImages && currentPage > 1) { loadImages(currentPage - 1); } }

/** 处理点击下一页 */
function handleNextPage() { if (!isLoadingImages && currentPage < totalPages) { loadImages(currentPage + 1); } }

// --- 初始化函数 ---
function init() {
    if (!startButton || !stopButton || !prevButton || !nextButton || !pageInfo || !imageGrid || !statusDisplay || !actionMessage || !prevButtonBottom || !nextButtonBottom || !pageInfoBottom) {
        console.error("One or more required DOM elements not found. Initialization failed.");
        return; // 如果关键元素找不到，则不继续执行
    }

    startButton.addEventListener('click', () => handleSyncAction(START_SYNC_URL, startButton));
    stopButton.addEventListener('click', () => handleSyncAction(STOP_SYNC_URL, stopButton));
    prevButton.addEventListener('click', handlePrevPage);
    nextButton.addEventListener('click', handleNextPage);
    prevButtonBottom.addEventListener('click', handlePrevPage);
    nextButtonBottom.addEventListener('click', handleNextPage);

    loadImages(currentPage);
    fetchStatus();

    if (statusIntervalId) clearInterval(statusIntervalId);
    statusIntervalId = setInterval(fetchStatus, STATUS_POLL_INTERVAL);
    console.log(`Status polling started (interval: ${STATUS_POLL_INTERVAL}ms)`);
}

// --- 脚本入口 ---
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}