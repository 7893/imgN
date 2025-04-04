#!/bin/bash

# 脚本：调用 API Worker 上的端点来重置 SyncCoordinatorDO 的状态

API_WORKER_URL="https://imgn-api-worker.53.workers.dev" # 你的 API Worker URL
RESET_ENDPOINT="/reset-sync-do"

echo "将向 $API_WORKER_URL 发送请求以重置 Durable Object 状态..."
echo -e "!!! \e[1;31m警告：这将重置同步状态，包括最后处理页码！\e[0m !!!"
echo "--------------------------------------------------"

# --- 用户确认 ---
read -p $'按 \e[1;32mEnter\e[0m 或输入 \e[1;32my/Y\e[0m 确认重置 DO 状态，输入其他任意字符取消: ' confirm_action
confirm_action_lower=${confirm_action,,} 
if [[ -n "$confirm_action" && "$confirm_action_lower" != "y" ]]; then
    echo "操作已取消。"
    exit 0
fi

echo "--- 正在发送重置请求 ---"

# --- 使用 curl 发送 POST 请求 ---
if curl -X POST "${API_WORKER_URL}${RESET_ENDPOINT}" - H "Content-Type: application/json" -w "\nHTTP Status: %{http_code}\n"; then
  echo "✅ 重置请求已发送。请检查 API Worker 和 DO 的日志确认状态。"
  exit 0
else
  echo "❌ 错误：发送重置请求失败。" >&2
  exit 1
fi