// ~/imgN/frontend/script.js (最终版 - Nginx 表格风格, 10条/页, 无图, 清理日志)

// --- 配置 ---
const API_BASE_URL = `https://imgn-api-worker.53.workers.dev`;
const IMAGES_API_URL = `${API_BASE_URL}/images`;
const START_SYNC_URL = `${API_BASE_URL}/start-sync`;
const STOP_SYNC_URL = `${API_BASE_URL}/stop-sync`;
const STATUS_URL = `${API_BASE_URL}/sync-status`;
const STATUS_POLL_INTERVAL = 5000;
const IMAGES_PER_PAGE = 10;
const R2_PUBLIC_URL_BASE = 'https://pub-61b373cf3f6e4863a70b53ca5e61dc53.r2.dev'; // 你的 R2 URL

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
let statusIntervalId = null; let currentPage = 1; let totalPages = 1; let totalImages = 0; let isLoadingImages = false;

// --- R2 Key 处理辅助函数 ---
function sanitizeForR2KeyJs(tagName) { if (!tagName) return ''; const sanitized = tagName.toLowerCase().replace(/[\s+]+/g, '_').replace(/[^a-z0-9_-]/g, '').substring(0, 50); if (!sanitized || /^[_ -]+$/.test(sanitized)) { return ''; } return sanitized; }
function getFolderNameFromTagsJs(tagsData) { const defaultFolder = 'uncategorized'; let tags = []; if (tagsData) { try { tags = JSON.parse(tagsData); } catch (e) { console.error("解析 tags_data 失败:", tagsData, e); return defaultFolder; } } if (!Array.isArray(tags) || tags.length === 0) { return defaultFolder; } for (const tagTitle of tags) { const sanitized = sanitizeForR2KeyJs(tagTitle); if (sanitized) { return sanitized; } } return defaultFolder; }

// --- 其他辅助函数 ---
function showActionMessage(message, isError = false) { if (!actionMessage) return; actionMessage.textContent = message; actionMessage.className = isError ? 'action-message error' : 'action-message'; setTimeout(() => { if (actionMessage.textContent === message) { actionMessage.textContent = ''; actionMessage.className = 'action-message'; } }, 4000); }
async function handleSyncAction(url, button) { if (!button || button.disabled) return; const originalText = button.textContent; button.disabled = true; button.textContent = '处理中...'; showActionMessage('正在发送请求...', false); try { const response = await fetch(url, { method: 'POST' }); let result = { success: response.ok, message: response.statusText }; try { result = await response.json(); } catch (e) { /* Ignore */ } if (response.ok && result.success !== false) { showActionMessage(result.message || '操作成功！', false); setTimeout(fetchStatus, 100); } else { throw new Error(result.message || `请求失败: ${response.status}`); } } catch (error) { console.error('执行同步操作时出错:', url, error); showActionMessage(`错误: ${error.message}`, true); fetchStatus(); } finally { button.textContent = originalText; } }
async function fetchStatus() { if (!statusDisplay) return; let currentStatus = 'unknown'; try { const response = await fetch(STATUS_URL); if (!response.ok) throw new Error(`HTTP 错误! 状态: ${response.status}`); const result = await response.json(); if (result.success && result.data) { currentStatus = result.data.status || '未知'; const page = result.data.lastProcessedPage || 0; const lastError = result.data.lastError; let statusText = `状态: ${currentStatus} (上次处理页: ${page})`; if (currentStatus === 'error' && lastError) { statusText += ` - 错误: ${lastError.substring(0, 100)}${lastError.length > 100 ? '...' : ''}`; } statusDisplay.textContent = statusText; } else { throw new Error(result.message || '无法获取状态'); } } catch (error) { console.error('获取状态时出错:', error); statusDisplay.textContent = `状态: 获取错误`; if (startButton) startButton.disabled = false; if (stopButton) stopButton.disabled = false; return; } const isRunning = (currentStatus === 'running'); const isStopping = (currentStatus === 'stopping'); if (startButton) startButton.disabled = isRunning || isStopping; if (stopButton) stopButton.disabled = !isRunning; }

/** *** 修改：创建表格行，无图片预览 *** */
function createImageInfoRow(imageData) {
    const tr = document.createElement('tr');
    const photoId = imageData.id || '-';
    let originalLink = '#'; // 图片 ID 的链接目标

    // --- 准备数据 ---
    const displaySize = '-'; // 大小信息不可用
    const displayResolution = imageData.resolution || '-';
    const description = imageData.description || imageData.alt_description || '-';

    let locationDisplay = '-';
    if (imageData.location_details) {
        try { const loc = JSON.parse(imageData.location_details); locationDisplay = [loc?.city, loc?.country].filter(Boolean).join(', ') || loc?.name || '-'; if (locationDisplay.length > 50) locationDisplay = locationDisplay.substring(0, 50) + '...'; }
        catch (e) { console.error("解析地点 JSON 失败:", imageData.location_details, e); }
    }

    const timeStr = imageData.created_at_api || imageData.updated_at_api; // 优先用创建时间
    let displayTime = '-';
    if (timeStr) { try { displayTime = new Date(timeStr).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { } }

    let tagsDisplay = '-';
    if (imageData.tags_data) {
        try { const tagsArray = JSON.parse(imageData.tags_data); if (Array.isArray(tagsArray) && tagsArray.length > 0) { tagsDisplay = tagsArray.join(' '); } }
        catch (e) { console.error("解析 Tags JSON 失败:", imageData.tags_data, e); }
    }

    // --- 获取原始链接 (优先 Unsplash HTML 链接) ---
    try { if (imageData.photo_links) { const links = JSON.parse(imageData.photo_links); originalLink = links?.html || '#'; } }
    catch (e) { /* ignore */ }
    // 如果没有 Unsplash 链接，并且 R2 URL 可构造，则链接到 R2
    if (originalLink === '#' && photoId !== '-' && R2_PUBLIC_URL_BASE && R2_PUBLIC_URL_BASE !== 'https://<你的R2公共URL>') {
        const folderName = getFolderNameFromTagsJs(imageData.tags_data);
        const r2Key = `${folderName}/${photoId}`;
        originalLink = `${R2_PUBLIC_URL_BASE.replace(/\/$/, '')}/${r2Key}`;
    }

    // 构建表格行内容 (没有 img 标签)
    tr.innerHTML = `
        <td><a href="${originalLink}" target="_blank" title="查看来源">${photoId}</a></td>
        <td>${displaySize}</td>
        <td>${displayResolution}</td>
        <td>${locationDisplay}</td>
        <td>${displayTime}</td> 
        <td>${tagsDisplay}</td>
        <td>${description}</td>
    `;
    return tr;
}

/** 加载并显示图片信息到表格 */
async function loadImages(page = 1) {
    if (!imageTableBody || isLoadingImages) { if (!imageTableBody) console.error("无法找到 #image-table-body 元素!"); return; }
    isLoadingImages = true;
    imageTableBody.innerHTML = `<tr><td colspan="7" class="loading-cell">正在加载信息...</td></tr>`;
    updatePaginationUI();
    currentPage = page;
    try {
        const url = `${IMAGES_API_URL}?page=${currentPage}&limit=${IMAGES_PER_PAGE}`;
        // console.log(`从 API 获取图片信息: ${url}`); // 移除调试信息
        const response = await fetch(url);
        if (!response.ok) { throw new Error(`HTTP 错误! 状态: ${response.status}`); }
        const jsonData = await response.json();
        // console.log("接收到图片数据:", jsonData); // 移除调试信息

        if (jsonData.success && jsonData.data?.images) {
            imageTableBody.innerHTML = '';
            totalImages = jsonData.data.totalImages || 0;
            totalPages = jsonData.data.totalPages || 1;
            const imagesToRender = jsonData.data.images;

            if (imagesToRender && imagesToRender.length > 0) {
                // console.log(`[loadImages] 准备渲染 ${imagesToRender.length} 行数据...`); // 移除调试信息
                imagesToRender.forEach((image) => { // 移除 index
                    // console.log(`[loadImages] 处理 ID: ${image?.id}`); // 移除调试信息
                    const tableRow = createImageInfoRow(image);
                    if (tableRow) { imageTableBody.appendChild(tableRow); }
                    else { console.warn(`[loadImages] 未能为图片 ID 创建表格行: ${image?.id}`); } // 保留警告
                });
            } else {
                const emptyMsg = (currentPage === 1) ? '数据库中还没有图片信息。请尝试启动同步。' : '当前页没有图片信息。';
                imageTableBody.innerHTML = `<tr><td colspan="7" class="loading-cell">${emptyMsg}</td></tr>`;
            }
            updatePaginationUI();
        } else {
            console.error("[loadImages] API 返回数据结构不正确或失败:", jsonData); // 保留错误日志
            throw new Error(jsonData.message || '加载信息失败 (API 数据问题)。');
        }
    } catch (error) {
        console.error('[loadImages] 加载信息过程中出错:', error);
        if (imageTableBody) { imageTableBody.innerHTML = `<tr><td colspan="7" class="loading-cell" style="color: red;">加载信息出错: ${error.message}</td></tr>`; }
        totalPages = currentPage;
        updatePaginationUI();
    } finally {
        isLoadingImages = false;
        updatePaginationUI();
        // console.log("[loadImages] 加载流程结束."); // 移除调试信息
    }
}

// 更新分页 UI
function updatePaginationUI() { const pageInfoText = `第 ${currentPage} / ${totalPages} 页 (共 ${totalImages} 条记录)`; if (pageInfo) pageInfo.textContent = pageInfoText; if (pageInfoBottom) pageInfoBottom.textContent = pageInfoText; const disablePrev = isLoadingImages || currentPage <= 1; const disableNext = isLoadingImages || currentPage >= totalPages; if (prevButton) prevButton.disabled = disablePrev; if (prevButtonBottom) prevButtonBottom.disabled = disablePrev; if (nextButton) nextButton.disabled = disableNext; if (nextButtonBottom) nextButtonBottom.disabled = disableNext; }

// 分页按钮处理
function handlePrevPage() { if (!isLoadingImages && currentPage > 1) { loadImages(currentPage - 1); } }
function handleNextPage() { if (!isLoadingImages && currentPage < totalPages) { loadImages(currentPage + 1); } }

// --- 初始化函数 ---
function init() { if (!startButton || !stopButton || !prevButton || !nextButton || !pageInfo || !imageTableBody || !statusDisplay || !actionMessage || !prevButtonBottom || !nextButtonBottom || !pageInfoBottom) { console.error("DOM 元素缺失，初始化失败！"); return; } startButton.addEventListener('click', () => handleSyncAction(START_SYNC_URL, startButton)); stopButton.addEventListener('click', () => handleSyncAction(STOP_SYNC_URL, stopButton)); prevButton.addEventListener('click', handlePrevPage); nextButton.addEventListener('click', handleNextPage); prevButtonBottom.addEventListener('click', handlePrevPage); nextButtonBottom.addEventListener('click', handleNextPage); loadImages(currentPage); fetchStatus(); if (statusIntervalId) clearInterval(statusIntervalId); statusIntervalId = setInterval(fetchStatus, STATUS_POLL_INTERVAL); console.log(`状态轮询已启动.`); } // 保留这个启动日志

// --- 脚本入口 ---
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }