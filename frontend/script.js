// ~/imgN/frontend/script.js (添加了分页逻辑)

// --- 配置 ---
const API_BASE_URL = `https://imgn-api-worker.53.workers.dev`;
const IMAGES_API_URL = `${API_BASE_URL}/images`;
const START_SYNC_URL = `${API_BASE_URL}/start-sync`;
const STOP_SYNC_URL = `${API_BASE_URL}/stop-sync`;
const STATUS_URL = `${API_BASE_URL}/sync-status`;
const STATUS_POLL_INTERVAL = 5000;
const IMAGES_PER_PAGE = 12; // 与 API 默认值或你希望的值保持一致

// --- DOM 元素获取 ---
const imageGrid = document.getElementById('image-grid');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const statusDisplay = document.getElementById('statusDisplay');
const actionMessage = document.getElementById('actionMessage');
// 获取分页元素
const prevButton = document.getElementById('prevButton');
const nextButton = document.getElementById('nextButton');
const pageInfo = document.getElementById('pageInfo');
// 获取底部分页元素 (如果存在)
const prevButtonBottom = document.getElementById('prevButtonBottom');
const nextButtonBottom = document.getElementById('nextButtonBottom');
const pageInfoBottom = document.getElementById('pageInfoBottom');


// --- 状态变量 ---
let statusIntervalId = null;
let currentPage = 1; // 当前页码
let totalPages = 1;  // 总页数 (从 API 获取)
let isLoadingImages = false; // 防止重复加载

// --- 辅助函数 ---

// 显示操作反馈信息 (保持不变)
function showActionMessage(message, isError = false) { /* ... */ if (!actionMessage) return; actionMessage.textContent = message; actionMessage.className = isError ? 'action-message error' : 'action-message'; setTimeout(() => { if (actionMessage.textContent === message) { actionMessage.textContent = ''; actionMessage.className = 'action-message'; } }, 4000); }

// 处理点击 "Start/Stop" 按钮 (保持不变)
async function handleSyncAction(url, button) { /* ... */ if (!button) return; button.disabled = true; showActionMessage('正在发送请求...', false); try { const response = await fetch(url, { method: 'POST' }); let result = { success: response.ok, message: response.statusText }; try { result = await response.json(); } catch (e) { console.warn("Response body is not JSON...", e); } if (response.ok && result.success) { showActionMessage(result.message || '操作成功！', false); fetchStatus(); } else { throw new Error(result.message || `请求失败: ${response.status}`); } } catch (error) { console.error('执行同步操作时出错:', url, error); showActionMessage(`错误: ${error.message}`, true); } finally { button.disabled = false; } }

// 获取并显示同步状态 (保持不变)
async function fetchStatus() { /* ... */ if (!statusDisplay) return; try { const response = await fetch(STATUS_URL); if (!response.ok) { throw new Error(`HTTP error! Status: ${response.status}`); } const result = await response.json(); if (result.success && result.data) { const status = result.data.status || 'unknown'; const page = result.data.lastProcessedPage || 0; const lastError = result.data.lastError; let statusText = `状态: ${status} (上次处理页: ${page})`; if (status === 'error' && lastError) { statusText += ` - 错误: ${lastError}`; } statusDisplay.textContent = statusText; if (startButton) startButton.disabled = (status === 'running'); if (stopButton) stopButton.disabled = (status !== 'running' && status !== 'stopping'); } else { throw new Error(result.message || 'Could not get status'); } } catch (error) { console.error('获取状态时出错:', error); statusDisplay.textContent = `状态: 获取错误`; if (startButton) startButton.disabled = false; if (stopButton) stopButton.disabled = false; } }

// 创建图片卡片 HTML (保持不变)
function createImageCard(imageData) { /* ... */ const card = document.createElement('div'); card.classList.add('image-card'); let imageUrl = null; let authorName = '未知作者'; let authorLink = '#'; let description = imageData.description || imageData.alt_description || '<i>无描述</i>'; try { if (imageData.image_urls) { const urls = JSON.parse(imageData.image_urls); imageUrl = urls?.small || urls?.regular || urls?.thumb; } if (!imageUrl && imageData.photo_url) { imageUrl = imageData.photo_url; } if (imageData.author_details) { const author = JSON.parse(imageData.author_details); authorName = author?.name || authorName; authorLink = author?.links?.html || authorLink; } } catch (e) { console.error("解析卡片 JSON 时出错:", e, imageData); } if (!imageUrl) { console.warn("找不到有效图片 URL:", imageData.id); return null; } card.innerHTML = `<a href="${imageData.photo_links ? JSON.parse(imageData.photo_links)?.html || imageUrl : imageUrl}" target="_blank" rel="noopener noreferrer"><img src="${imageUrl}" alt="${imageData.alt_description || imageData.description || 'Unsplash Image'}" loading="lazy"></a><div class="image-info"><p class="description">${description}</p><p class="author">作者: <a href="${authorLink}" target="_blank" rel="noopener noreferrer">${authorName}</a></p><p class="likes">点赞: ${imageData.likes || 0}</p></div>`; return card; }

// --- 修改：加载并显示图片 (带分页) ---
async function loadImages(page = 1) {
    if (!imageGrid || isLoadingImages) return; // 防止重复加载

    isLoadingImages = true; // 标记开始加载
    imageGrid.innerHTML = '<p>正在加载图片...</p>';
    // 临时禁用分页按钮
    if (prevButton) prevButton.disabled = true;
    if (nextButton) nextButton.disabled = true;
    if (prevButtonBottom) prevButtonBottom.disabled = true;
    if (nextButtonBottom) nextButtonBottom.disabled = true;

    // 更新当前页码状态
    currentPage = page;

    try {
        // 构建带分页参数的 API URL
        const url = `${IMAGES_API_URL}?page=${currentPage}&limit=${IMAGES_PER_PAGE}`;
        console.log(`从 API 获取图片: ${url}`);
        const response = await fetch(url);
        if (!response.ok) { throw new Error(`HTTP 错误! 状态: ${response.status}`); }
        const jsonData = await response.json();
        console.log("接收到图片数据:", jsonData);

        if (jsonData.success && jsonData.data?.images) {
            imageGrid.innerHTML = ''; // 清空加载提示
            totalPages = jsonData.data.totalPages || 1; // 更新总页数
            const images = jsonData.data.images;

            if (images.length > 0) {
                images.forEach(image => {
                    const card = createImageCard(image);
                    if (card) { imageGrid.appendChild(card); }
                });
            } else {
                imageGrid.innerHTML = '<p>当前页没有图片。</p>'; // 本页无图提示
            }

            // 更新分页信息和按钮状态
            updatePaginationUI();

        } else { throw new Error(jsonData.message || '加载图片失败。'); }

    } catch (error) {
        console.error('加载图片时出错:', error);
        if (imageGrid) { imageGrid.innerHTML = `<p style="color: red;">加载图片出错: ${error.message}</p>`; }
        // 出错时也更新下分页UI，防止按钮一直禁用
        updatePaginationUI();
    } finally {
        isLoadingImages = false; // 标记加载结束
    }
}

/** 更新分页控件的 UI (页码显示和按钮禁用状态) */
function updatePaginationUI() {
    const pageInfoText = `Page ${currentPage} / ${totalPages}`;
    if (pageInfo) pageInfo.textContent = pageInfoText;
    if (pageInfoBottom) pageInfoBottom.textContent = pageInfoText;

    // 更新上一页按钮状态
    const disablePrev = currentPage <= 1;
    if (prevButton) prevButton.disabled = disablePrev;
    if (prevButtonBottom) prevButtonBottom.disabled = disablePrev;

    // 更新下一页按钮状态
    const disableNext = currentPage >= totalPages;
    if (nextButton) nextButton.disabled = disableNext;
    if (nextButtonBottom) nextButtonBottom.disabled = disableNext;
}

/** 处理点击上一页 */
function handlePrevPage() {
    if (currentPage > 1) {
        loadImages(currentPage - 1);
    }
}

/** 处理点击下一页 */
function handleNextPage() {
    if (currentPage < totalPages) {
        loadImages(currentPage + 1);
    }
}

// --- 初始化函数 ---
function init() {
    // 绑定按钮事件
    if (startButton) startButton.addEventListener('click', () => handleSyncAction(START_SYNC_URL, startButton));
    if (stopButton) stopButton.addEventListener('click', () => handleSyncAction(STOP_SYNC_URL, stopButton));

    // 绑定分页按钮事件
    if (prevButton) prevButton.addEventListener('click', handlePrevPage);
    if (nextButton) nextButton.addEventListener('click', handleNextPage);
    if (prevButtonBottom) prevButtonBottom.addEventListener('click', handlePrevPage);
    if (nextButtonBottom) nextButtonBottom.addEventListener('click', handleNextPage);

    // 页面加载时立即执行的操作
    loadImages(currentPage); // 加载第一页图片
    fetchStatus(); // 获取初始状态

    // 启动定时轮询获取状态 (保持不变)
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