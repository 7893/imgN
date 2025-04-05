// ~/imgN/frontend/script.js (修正了按钮和状态逻辑)

// --- 配置 (保持不变) ---
const API_BASE_URL = `https://imgn-api-worker.53.workers.dev`;
const IMAGES_API_URL = `${API_BASE_URL}/images`;
const START_SYNC_URL = `${API_BASE_URL}/start-sync`;
const STOP_SYNC_URL = `${API_BASE_URL}/stop-sync`;
const STATUS_URL = `${API_BASE_URL}/sync-status`;
const STATUS_POLL_INTERVAL = 5000;
const IMAGES_PER_PAGE = 10;
const R2_PUBLIC_URL_BASE = 'https://pub-61b373cf3f6e4863a70b53ca5e61dc53.r2.dev';

// --- DOM 元素获取 (保持不变) ---
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

// --- 状态变量 (保持不变) ---
let statusIntervalId = null; let currentPage = 1; let totalPages = 1; let totalImages = 0; let isLoadingImages = false;

// --- R2 Key 处理辅助函数 (保持不变) ---
function sanitizeForR2KeyJs(tagName) { /* ... */ }
function getFolderNameFromTagsJs(tagsData) { /* ... */ }

// --- 其他辅助函数 ---

/** 显示操作反馈信息 (保持不变) */
function showActionMessage(message, isError = false) { /* ... */ if (!actionMessage) return; actionMessage.textContent = message; actionMessage.className = isError ? 'action-message error' : 'action-message'; setTimeout(() => { if (actionMessage.textContent === message) { actionMessage.textContent = ''; actionMessage.className = 'action-message'; } }, 4000); }

/** * 处理点击 "Start/Stop" 按钮 (修改：只禁用当前按钮)
 * 按钮的最终启用/禁用状态由 fetchStatus 控制 
 */
async function handleSyncAction(url, button) {
    if (!button || button.disabled) return; // 如果按钮已禁用（例如状态不允许），则不执行

    const originalText = button.textContent; // 保存原始文本
    button.disabled = true; // 临时禁用当前按钮
    button.textContent = '处理中...'; // 提示处理中

    showActionMessage('正在发送请求...', false);
    try {
        const response = await fetch(url, { method: 'POST' });
        let result = { success: response.ok, message: response.statusText };
        try { result = await response.json(); } catch (e) { /* Ignore if not JSON */ }

        if (response.ok && result.success !== false) { // 检查 success 是否明确为 false
            showActionMessage(result.message || '操作成功！', false);
            // 不立即启用按钮，等待 fetchStatus 更新状态来决定
            setTimeout(fetchStatus, 100); // 稍等一下再获取状态，给后端一点时间反应
        } else { throw new Error(result.message || `请求失败: ${response.status}`); }
    } catch (error) {
        console.error('执行同步操作时出错:', url, error);
        showActionMessage(`错误: ${error.message}`, true);
        fetchStatus(); // 出错时也尝试刷新状态，可能会恢复按钮
    } finally {
        // 请求结束后恢复按钮原始文本 (按钮是否可用由 fetchStatus 决定)
        button.textContent = originalText;
        // button.disabled = false; // <-- 不再在这里强制启用，由 fetchStatus 控制
    }
}

/** * 获取并显示同步状态 (修改：调整按钮禁用逻辑) 
 */
async function fetchStatus() {
    if (!statusDisplay) return;
    let currentStatus = 'unknown'; // 先假设未知状态

    try {
        const response = await fetch(STATUS_URL);
        if (!response.ok) throw new Error(`HTTP 错误! 状态: ${response.status}`);
        const result = await response.json();
        if (result.success && result.data) {
            currentStatus = result.data.status || 'unknown'; // 获取真实状态
            const page = result.data.lastProcessedPage || 0;
            const lastError = result.data.lastError;
            let statusText = `状态: ${currentStatus} (上次处理页: ${page})`;
            if (currentStatus === 'error' && lastError) { statusText += ` - 错误: ${lastError.substring(0, 100)}${lastError.length > 100 ? '...' : ''}`; }
            statusDisplay.textContent = statusText;

        } else { throw new Error(result.message || '无法获取状态'); }
    } catch (error) {
        console.error('获取状态时出错:', error);
        statusDisplay.textContent = `状态: 获取错误`;
        // *** 修改：获取状态出错时，保守地启用所有控制按钮，允许用户重试 ***
        if (startButton) startButton.disabled = false;
        if (stopButton) stopButton.disabled = false;
        return; // 获取状态失败，不再继续更新按钮状态
    }

    // *** 修改：根据获取到的真实状态控制按钮 ***
    const isRunning = (currentStatus === 'running');
    const isStopping = (currentStatus === 'stopping');
    if (startButton) startButton.disabled = isRunning || isStopping; // 运行时或停止中不能开始
    if (stopButton) stopButton.disabled = !isRunning; // 只有运行时才能停止 (停止中时禁用停止按钮意义不大)
}

// 创建图片表格行 (保持不变)
function createImageInfoRow(imageData) { /* ... (与上一版本相同) ... */ }

// 加载并显示图片信息到表格 (保持不变)
async function loadImages(page = 1) { /* ... (与上一版本相同) ... */ }

// 更新分页控件的 UI (保持不变)
function updatePaginationUI() { /* ... */ }

// 分页按钮处理 (保持不变)
function handlePrevPage() { if (!isLoadingImages && currentPage > 1) { loadImages(currentPage - 1); } }
function handleNextPage() { if (!isLoadingImages && currentPage < totalPages) { loadImages(currentPage + 1); } }

// --- 初始化函数 (保持不变) ---
function init() { /* ... */ }

// --- 脚本入口 (保持不变) ---
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }