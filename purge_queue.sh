#!/bin/bash

# 脚本：清空（Purge）指定的 Cloudflare Queue 中的所有消息

# --- 配置 ---
QUEUE_NAME="imgn-queue-sync-tasks-20240402" # 要清空消息的队列名称

echo "本脚本将尝试清空队列 '$QUEUE_NAME' 中的所有等待中和延迟的消息。"
echo -e "!!! \e[1;31m警告：此操作不可逆，将移除所有未处理的消息！\e[0m !!!"
echo "--------------------------------------------------"

# --- 检查工具和凭证 ---
# ... (同之前的脚本，检查 wrangler 和凭证) ...
if ! command -v wrangler &> /dev/null; then echo "错误：未找到 'wrangler' 命令。" >&2; exit 1; fi
if [[ -z "$CLOUDFLARE_ACCOUNT_ID" && -z "$TF_VAR_cloudflare_account_id" ]]; then echo "警告：未检测到 Cloudflare Account ID 环境变量。" >&2; fi

# --- 用户确认 ---
read -p $'按 \e[1;32mEnter\e[0m 或输入 \e[1;32my/Y\e[0m 确认清空队列 '$QUEUE_NAME'，输入其他任意字符取消: ' confirm_action
confirm_action_lower=${confirm_action,,} 
if [[ -n "$confirm_action" && "$confirm_action_lower" != "y" ]]; then
    echo "操作已取消。"
    exit 0
fi

echo "--- 开始清空队列 '$QUEUE_NAME' ---"

# --- 执行 Purge 命令 ---
if wrangler queues purge "$QUEUE_NAME"; then
    echo "✅ 队列 '$QUEUE_NAME' 已成功清空。"
    exit 0
else
    echo "❌ 错误：清空队列 '$QUEUE_NAME' 时发生错误。" >&2
    echo "请检查 wrangler 的输出。" >&2
    exit 1
fi