// ~/imgN/frontend/script.js

// --- 配置 ---
const API_BASE_URL = `https://imgn-api-worker.53.workers.dev`; // 使用你记录的 worker URL
const IMAGES_API_URL = `${API_BASE_URL}/images`;
const START_SYNC_URL = `${API_BASE_URL}/start-sync`;
const STOP_SYNC_URL = `${API_BASE_URL}/stop-sync`;
const STATUS_URL = `${API_BASE_URL}/sync-status`;
const STATUS_POLL_INTERVAL = 5000; // 每 5 秒检查一次状态 (毫秒)

// --- DOM 元素获取 ---
const imageGrid = document.getElementById('image-grid');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const statusDisplay = document.getElementById('statusDisplay');
const actionMessage = document.getElementById('actionMessage');

// --- 状态变量 ---
let statusIntervalId = null; // 存储轮询定时器的 ID

// --- 辅助函数 ---

/**
 * 显示操作反馈信息 (例如 "Sync started successfully.")
 * @param {string} message - 要显示的消息
 * @param {boolean} isError - 是否是错误消息 (用于设置样式)
 */
function showActionMessage(message, isError = false) {
    if (!actionMessage) return;
    actionMessage.textContent = message;
    actionMessage.className = isError ? 'action-message error' : 'action-message';
    // 4 秒后自动清除消息
    setTimeout(() => {
         // 只有当消息仍然是当前显示的消息时才清除，防止清除掉新的消息
         if (actionMessage.textContent === message) { 
            actionMessage.textContent = '';
            actionMessage.className = 'action-message';
         }
    }, 4000);
}

/**
 * 处理点击 "Start Sync" 或 "Stop Sync" 按钮的函数
 * @param {string} url - 要请求的 API 端点 URL
 * @param {HTMLButtonElement} button - 被点击的按钮元素
 */
async function handleSyncAction(url, button) {
    if (!button) return;
    button.disabled = true; // 请求期间禁用按钮
    showActionMessage('正在发送请求...', false); // 显示请求中提示
    try {
        const response = await fetch(url, { method: 'POST' });
        // 尝试解析 JSON，即使失败也要继续，因为某些成功响应可能没有 JSON body
        let result = { success: response.ok, message: response.statusText }; // 默认值
        try {
            result = await response.json();
        } catch (e) {
            console.warn("Response body is not JSON or parsing failed, using status code for success check.", e);
        }

        if (response.ok && result.success) {
            showActionMessage(result.message || '操作成功！', false);
            fetchStatus(); // 操作成功后立即刷新状态
        } else {
            // 如果 result.message 存在则用它，否则用 response.statusText
            throw new Error(result.message || `请求失败，状态码: ${response.status}`);
        }
    } catch (error) {
        console.error('执行同步操作时出错:', url, error);
        showActionMessage(`错误: ${error.message}`, true);
    } finally {
        button.disabled = false; // 无论成功失败，重新启用按钮
    }
}

/**
 * 从 API 获取同步状态并更新页面显示
 */
async function fetchStatus() {
     if (!statusDisplay) return;
     // console.log("Fetching status..."); // Debug log
     try {
         const response = await fetch(STATUS_URL);
         if (!response.ok) {
             throw new Error(`HTTP 错误! 状态: ${response.status}`);
         }
         const result = await response.json();
         if (result.success && result.data) {
             const status = result.data.status || 'unknown';
             const page = result.data.lastProcessedPage || 0;
             const lastError = result.data.lastError; // 获取错误信息
             let statusText = `状态: ${status} (上次处理页: ${page})`;
             if (status === 'error' && lastError) {
                 statusText += ` - 错误: ${lastError}`;
             }
             statusDisplay.textContent = statusText;
             
             // 根据状态控制按钮可用性 (可选但推荐)
             if (startButton) startButton.disabled = (status === 'running');
             if (stopButton) stopButton.disabled = (status !== 'running' && status !== 'stopping'); // 只有 running 或 stopping 时才可停止

         } else {
              throw new Error(result.message || '无法获取状态');
         }
     } catch (error) {
          console.error('获取状态时出错:', error);
          statusDisplay.textContent = `状态: 获取错误`;
          // 出错时，可能需要启用所有按钮
          if (startButton) startButton.disabled = false;
          if (stopButton) stopButton.disabled = false;
     }
}

/**
 * 创建单个图片卡片的 HTML 元素
 * @param {object} imageData - 从 API 获取的单张图片数据 (对应 D1 行)
 * @returns {HTMLElement | null} - 创建的卡片元素，如果数据无效则返回 null
 */
function createImageCard(imageData) {
	const card = document.createElement('div');
	card.classList.add('image-card'); 
    let imageUrl = null; 
    let authorName = '未知作者';
    let authorLink = '#';
    let description = imageData.description || imageData.alt_description || '<i>无描述</i>';

    try {
        // 优先从 image_urls JSON 中解析
        if (imageData.image_urls) { 
			const urls = JSON.parse(imageData.image_urls);
			// 优先选用 small 或 regular 尺寸用于展示
			imageUrl = urls?.small || urls?.regular || urls?.thumb; 
		}
        // 如果没有 image_urls，尝试使用旧的 photo_url 字段 (以防万一)
        if (!imageUrl && imageData.photo_url) { 
             imageUrl = imageData.photo_url;
        }
        
		if (imageData.author_details) {
			const author = JSON.parse(imageData.author_details);
			authorName = author?.name || authorName;
			authorLink = author?.links?.html || authorLink;
		}
	} catch (e) { console.error("解析图片卡片 JSON 时出错:", e, imageData); }

    // 如果最终没有有效的图片 URL，则不创建卡片
    if (!imageUrl) {
         console.warn("找不到有效的图片 URL:", imageData.id);
         return null; 
    }

	card.innerHTML = `
		<a href="${imageData.photo_links ? JSON.parse(imageData.photo_links)?.html || imageUrl : imageUrl}" target="_blank" rel="noopener noreferrer"> 
			<img src="${imageUrl}" alt="${imageData.alt_description || imageData.description || 'Unsplash Image'}" loading="lazy">
		</a>
		<div class="image-info">
			<p class="description">${description}</p>
			<p class="author">作者: <a href="${authorLink}" target="_blank" rel="noopener noreferrer">${authorName}</a></p>
			<p class="likes">点赞: ${imageData.likes || 0}</p>
		</div>
	`;
	return card;
}

/**
 * 从 API 加载图片数据并渲染到页面网格中
 */
async function loadImages() {
	if (!imageGrid) { console.error('无法找到 #image-grid 元素!'); return; }
	imageGrid.innerHTML = '<p>正在加载图片...</p>'; 
	try {
		console.log(`从 API 获取图片: ${IMAGES_API_URL}`);
		// TODO: 实现分页加载，现在总是加载第一页
		const response = await fetch(IMAGES_API_URL); 
		if (!response.ok) { throw new Error(`HTTP 错误! 状态: ${response.status}`); }
		const jsonData = await response.json();
		console.log("接收到图片数据:", jsonData);
		if (jsonData.success && jsonData.data?.images?.length > 0) {
			imageGrid.innerHTML = ''; // 清空加载提示
			jsonData.data.images.forEach(image => {
				const card = createImageCard(image);
                if (card) { // 确保卡片创建成功再添加
				    imageGrid.appendChild(card);
                }
			});
		} else if (jsonData.success) { 
            imageGrid.innerHTML = '<p>图库中还没有图片。请尝试启动同步。</p>'; // 更友好的提示
        } else { throw new Error(jsonData.message || '加载图片失败。'); }
	} catch (error) {
		console.error('加载图片时出错:', error);
		if (imageGrid) { imageGrid.innerHTML = `<p style="color: red;">加载图片出错: ${error.message}</p>`; }
	}
}

// --- 初始化函数 ---
function init() {
    // 绑定按钮事件
    if (startButton) {
        startButton.addEventListener('click', () => handleSyncAction(START_SYNC_URL, startButton));
    } else {
        console.warn("Start button not found");
    }
    if (stopButton) {
        stopButton.addEventListener('click', () => handleSyncAction(STOP_SYNC_URL, stopButton));
    } else {
         console.warn("Stop button not found");
    }

    // 页面加载时立即执行的操作
    loadImages(); // 加载图片
    fetchStatus(); // 获取初始状态

    // 启动定时轮询获取状态
    if (statusIntervalId) clearInterval(statusIntervalId); // 清除可能存在的旧定时器
    statusIntervalId = setInterval(fetchStatus, STATUS_POLL_INTERVAL);
    console.log(`Status polling started (interval: ${STATUS_POLL_INTERVAL}ms)`);
}

// --- 脚本入口 ---
// 等待 DOM 加载完成后再执行初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init(); // 如果 DOM 已经加载完成，则立即执行
}