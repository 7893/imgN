// ~/imgN/frontend/script.js (添加了更详细的调试日志)

// --- 配置 (保持不变) ---
const API_BASE_URL = `https://imgn-api-worker.53.workers.dev`;
const IMAGES_API_URL = `${API_BASE_URL}/images`;
const START_SYNC_URL = `${API_BASE_URL}/start-sync`;
const STOP_SYNC_URL = `${API_BASE_URL}/stop-sync`;
const STATUS_URL = `${API_BASE_URL}/sync-status`;
const STATUS_POLL_INTERVAL = 5000;
const IMAGES_PER_PAGE = 10;
const R2_PUBLIC_URL_BASE = 'https://pub-61b373cf3f6e4863a70b53ca5e61dc53.r2.dev'; // 使用你确认过的 URL

// --- DOM 元素获取 (保持不变) ---
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

// --- 状态变量 (保持不变) ---
let statusIntervalId = null; let currentPage = 1; let totalPages = 1; let totalImages = 0; let isLoadingImages = false;

// --- R2 Key 处理辅助函数 (保持不变) ---
function sanitizeForR2KeyJs(tagName) { if (!tagName) return ''; const sanitized = tagName.toLowerCase().replace(/[\s+]+/g, '_').replace(/[^a-z0-9_-]/g, '').substring(0, 50); if (!sanitized || /^[_ -]+$/.test(sanitized)) { return ''; } return sanitized; }
function getFolderNameFromTagsJs(tagsData) { const defaultFolder = 'uncategorized'; let tags = []; if (tagsData) { try { tags = JSON.parse(tagsData); } catch (e) { console.error("解析 tags_data 失败:", tagsData, e); return defaultFolder; } } if (!Array.isArray(tags) || tags.length === 0) { return defaultFolder; } for (const tagTitle of tags) { const sanitized = sanitizeForR2KeyJs(tagTitle); if (sanitized) { return sanitized; } } return defaultFolder; }

// --- 其他辅助函数 (保持不变) ---
function showActionMessage(message, isError = false) { /* ... */ }
async function handleSyncAction(url, button) { /* ... */ }
async function fetchStatus() { /* ... */ }

/** 创建图片卡片 HTML (添加了更多日志) */
function createImageCard(imageData) {
    // *** 新增日志：函数入口和接收的数据 ***
    console.log(`[createImageCard] 开始处理图片 ID: ${imageData?.id}`, imageData);

    const card = document.createElement('div');
    card.classList.add('image-card');
    let authorName = '未知作者';
    let authorLink = '#';
    let description = imageData.description || imageData.alt_description || '<i>无描述</i>';
    let r2ImageUrl = null;
    const photoId = imageData?.id; // 安全访问 id
    let originalLink = '#';
    let folderName = 'uncategorized'; // 默认文件夹
    let r2Key = ''; // 初始化 R2 key

    // 解析 JSON 数据 (保持不变)
    try { if (imageData.author_details) { const author = JSON.parse(imageData.author_details); authorName = author?.name || authorName; authorLink = author?.links?.html || authorLink; } if (imageData.photo_links) { const links = JSON.parse(imageData.photo_links); originalLink = links?.html || originalLink; } } catch (e) { console.error("解析 JSON 时出错:", e, imageData); }

    // 构造 R2 URL
    if (photoId && R2_PUBLIC_URL_BASE && R2_PUBLIC_URL_BASE !== 'https://<你的R2公共URL>') {
        folderName = getFolderNameFromTagsJs(imageData.tags_data); // <-- 使用这个函数
        r2Key = `${folderName}/${photoId}`;
        r2ImageUrl = `${R2_PUBLIC_URL_BASE.replace(/\/$/, '')}/${r2Key}`;
        if (originalLink === '#') { originalLink = r2ImageUrl; }

        // *** 移动并修正 Debug 日志位置 ***
        console.log(`[Card for ${photoId}] Tags: ${imageData.tags_data}, Folder: ${folderName}, Key: ${r2Key}, R2 URL: ${r2ImageUrl}`);

    } else {
        // *** 增加无法构造 URL 的警告 ***
        console.warn(`无法构造 R2 URL (Photo ID: ${photoId}, Base URL Set: ${!!R2_PUBLIC_URL_BASE}, Base URL Placeholder?: ${R2_PUBLIC_URL_BASE === 'https://<你的R2公共URL>'})`);
        return null; // 无法构造 URL 则返回 null
    }

    // 如果 R2 URL 无效 (例如 folderName 和 photoId 都是空导致 key 只是 '/')
    if (!r2ImageUrl || r2Key === '/' || r2Key.startsWith('/')) {
        console.warn("构造出的 R2 图片 URL 无效:", r2ImageUrl, "Key:", r2Key, "Photo ID:", photoId);
        return null;
    }

    // 构建卡片内容
    card.innerHTML = `
		<a href="${originalLink}" target="_blank" rel="noopener noreferrer" title="查看原图或来源"> 
			<img src="${r2ImageUrl}" alt="${imageData.alt_description || imageData.description || 'Image from R2'}" loading="lazy" onerror="this.style.display='none'; console.error('Failed to load image:', this.src)"> 
            </a>
		<div class="image-info">
			<p class="description">${description}</p>
			<p class="author">作者: <a href="${authorLink}" target="_blank" rel="noopener noreferrer">${authorName}</a></p>
			<p class="likes">点赞: ${imageData.likes || 0}</p>
		</div>
	`;

    // *** 新增日志：函数出口 ***
    console.log(`[createImageCard] 成功创建卡片元素 для ID: ${photoId}`);
    return card;
}

/** 加载并显示图片 (添加了更多日志) */
async function loadImages(page = 1) {
    if (!imageGrid) { console.error("无法找到 #image-grid 元素!"); return; }
    if (isLoadingImages) { console.log("[loadImages] 正在加载中，跳过此次调用"); return; } // 防止重复加载日志

    isLoadingImages = true;
    imageGrid.innerHTML = '<p>正在加载图片...</p>';
    updatePaginationUI();

    currentPage = page;

    try {
        const url = `${IMAGES_API_URL}?page=${currentPage}&limit=${IMAGES_PER_PAGE}`;
        console.log(`[loadImages] 从 API 获取图片: ${url}`);
        const response = await fetch(url);
        if (!response.ok) { throw new Error(`HTTP 错误! 状态: ${response.status}`); }
        const jsonData = await response.json();

        // *** 新增：打印获取到的数据 ***
        console.log("[loadImages] 接收到 API 响应数据:", jsonData);

        if (jsonData.success && jsonData.data?.images) {
            imageGrid.innerHTML = '';
            totalImages = jsonData.data.totalImages || 0;
            totalPages = jsonData.data.totalPages || 1;
            const imagesToRender = jsonData.data.images; // 保存到变量

            if (imagesToRender && imagesToRender.length > 0) { // 确保数组存在且不为空
                console.log(`[loadImages] 准备渲染 ${imagesToRender.length} 张图片...`); // *** 新增日志 ***
                imagesToRender.forEach((image, index) => {
                    // *** 新增日志：开始处理单张图片 ***
                    console.log(`[loadImages] 处理图片索引 ${index}, ID: ${image?.id}`);
                    const card = createImageCard(image);
                    if (card) {
                        imageGrid.appendChild(card);
                        // *** 新增日志：确认卡片已添加 ***
                        console.log(`[loadImages] 已添加卡片 ID: ${image?.id}`);
                    } else {
                        // *** 新增日志：卡片创建失败 ***
                        console.warn(`[loadImages] 未能为图片 ID 创建卡片: ${image?.id}`);
                    }
                });
            } else {
                const emptyMsg = (currentPage === 1) ? '图库中还没有图片。请尝试启动同步。' : '当前页没有图片。';
                imageGrid.innerHTML = `<p style="text-align:center;">${emptyMsg}</p>`;
            }
            updatePaginationUI();
        } else {
            // 处理 API 返回 success:false 或 data.images 不存在的情况
            console.error("[loadImages] API 返回成功但数据结构不正确或无图片:", jsonData);
            throw new Error(jsonData.message || '加载图片失败 (API 数据问题)。');
        }

    } catch (error) {
        console.error('[loadImages] 加载图片过程中出错:', error);
        if (imageGrid) { imageGrid.innerHTML = `<p style="color: red; text-align:center;">加载图片出错: ${error.message}</p>`; }
        totalPages = currentPage;
        updatePaginationUI();
    } finally {
        isLoadingImages = false;
        updatePaginationUI();
        console.log("[loadImages] 加载流程结束."); // *** 新增日志 ***
    }
}

// 更新分页 UI (保持不变)
function updatePaginationUI() { /* ... */ const pageInfoText = `第 ${currentPage} / ${totalPages} 页 (共 ${totalImages} 张图片)`; if (pageInfo) pageInfo.textContent = pageInfoText; if (pageInfoBottom) pageInfoBottom.textContent = pageInfoText; const disablePrev = isLoadingImages || currentPage <= 1; const disableNext = isLoadingImages || currentPage >= totalPages; if (prevButton) prevButton.disabled = disablePrev; if (prevButtonBottom) prevButtonBottom.disabled = disablePrev; if (nextButton) nextButton.disabled = disableNext; if (nextButtonBottom) nextButtonBottom.disabled = disableNext; }

// 分页按钮处理 (保持不变)
function handlePrevPage() { if (!isLoadingImages && currentPage > 1) { loadImages(currentPage - 1); } }
function handleNextPage() { if (!isLoadingImages && currentPage < totalPages) { loadImages(currentPage + 1); } }

// --- 初始化函数 (保持不变) ---
function init() { /* ... 检查 DOM 元素 ... */ /* ... 添加事件监听 ... */ loadImages(currentPage); fetchStatus(); if (statusIntervalId) clearInterval(statusIntervalId); statusIntervalId = setInterval(fetchStatus, STATUS_POLL_INTERVAL); console.log(`状态轮询已启动.`); }

// --- 脚本入口 (保持不变) ---
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }