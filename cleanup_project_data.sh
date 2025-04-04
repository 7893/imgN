#!/bin/bash

# 脚本：统一清理 imgn 项目在 Cloudflare 中产生的数据 (v4 - 移除 R2, 修复 KV/Queue)
# 清理 D1 表数据, KV 键值对, Queue 消息, 并重置 DO 状态
# !!! 警告：此脚本执行破坏性操作，但会保留资源本身 !!!

# --- 配置 ---
D1_DATABASE_NAME="d1-imgn-20240402"
# R2_BUCKET_NAME="r2-imgn-20240402" # R2 清理已从此脚本移除
QUEUE_NAME="imgn-queue-sync-tasks-20240402"
KV_NAMESPACE_ID="735f5c8008a64addb2b94dd097876ae9"
KV_NAMESPACE_TITLE="imgn-kv-cache-20240402"
API_WORKER_URL="https://imgn-api-worker.53.workers.dev"
DO_RESET_ENDPOINT="/reset-sync-do"

echo "本脚本将尝试清理以下 imgn 项目资源中的 *数据*："
echo "  - D1 数据库: $D1_DATABASE_NAME (清空所有用户表中的行)"
# echo "  - R2 存储桶: $R2_BUCKET_NAME (此脚本不再处理 R2 对象删除)" # 移除 R2
echo "  - KV 命名空间: $KV_NAMESPACE_TITLE (删除所有键值对)"
echo "  - Queue: $QUEUE_NAME (清除所有消息)"
echo "  - Durable Object 状态: 通过 API ($API_WORKER_URL$DO_RESET_ENDPOINT) 重置"
echo ""
echo -e "!!! \e[1;31m警告：此操作不可逆，将删除数据！资源本身将被保留。\e[0m !!!"
echo "!!! \e[1;33m注意: 如果 KV 清理步骤失败并提示 'libatomic.so.1' 错误, 请先在服务器上运行: sudo apt update && sudo apt install libatomic1 -y\e[0m !!!"
echo "--------------------------------------------------"

# --- 检查依赖工具 ---
all_tools_found=true
# R2 不再需要 jq
for cmd in wrangler curl xargs; do # 移除 jq 检查 (如果 KV list 默认输出能被 xargs 处理)
    if ! command -v $cmd &> /dev/null; then
        echo "错误：未找到命令 '$cmd'。请先安装它。" >&2; all_tools_found=false
    fi
done
if [[ "$all_tools_found" = false ]]; then exit 1; fi
# --- 确认 Cloudflare 凭证 ---
if [[ -z "$CLOUDFLARE_ACCOUNT_ID" && -z "$TF_VAR_cloudflare_account_id" ]]; then
    echo "警告：未检测到 Cloudflare Account ID 环境变量。" >&2
fi

# --- 用户最终确认 ---
read -p $'!!! 请再次确认是否要执行以上所有数据清理操作?\n按 \e[1;32mEnter\e[0m 或输入 \e[1;32my/Y\e[0m 确认，输入其他任意字符取消: ' confirm_action
confirm_action_lower=${confirm_action,,}
if [[ -n "$confirm_action" && "$confirm_action_lower" != "y" ]]; then
    echo "操作已取消。"
    exit 0
fi

echo "--- 开始执行清理操作 ---"
FAIL_COUNT=0
STEP_COUNT=4 # 总步骤数减少为 4

# --- 1. 清空 D1 表数据 ---
echo "[1/$STEP_COUNT] 清空 D1 数据库 '$D1_DATABASE_NAME' 用户表数据..."
# 使用 --json 和 jq 获取列表仍然是 D1 最可靠的方式
if ! command -v jq &> /dev/null; then echo "错误: D1 清理需要 'jq'。"; ((FAIL_COUNT++)); else
    mapfile -t D1_TABLE_LIST < <(wrangler d1 execute "$D1_DATABASE_NAME" --remote --json --command="SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations';" | jq -r '.[].results[]? | .name')
    list_exit_code=$?
    if [ $list_exit_code -ne 0 ] && [ ${#D1_TABLE_LIST[@]} -eq 0 ]; then
         echo "  ⚠️ 获取 D1 表列表失败或未找到用户表。"
    elif [ ${#D1_TABLE_LIST[@]} -eq 0 ]; then
        echo "  ✅ D1 数据库 '$D1_DATABASE_NAME' 中没有用户表，无需清空。"
    else
        echo "  将清空表: ${D1_TABLE_LIST[*]}"
        d1_fail_flag=0
        for table_name in "${D1_TABLE_LIST[@]}"; do
            echo "    清空表 '$table_name'..."
            if ! wrangler d1 execute "$D1_DATABASE_NAME" --remote --command="DELETE FROM \"$table_name\";" > /dev/null 2>&1; then
                echo "    ❌ 错误：清空表 '$table_name' 失败。" >&2; d1_fail_flag=1
            fi
        done
        if [ $d1_fail_flag -eq 0 ]; then echo "  ✅ D1 用户表数据已成功清空。"; else ((FAIL_COUNT++)); fi
    fi
fi
echo "---"

# --- 2. 清空 R2 (已移除) ---
echo "[2/$STEP_COUNT] 清空 R2 存储桶 '$R2_BUCKET_NAME' 对象... (已跳过)"
echo "  ℹ️ R2 对象清理已从此脚本移除，如有需要请通过 Cloudflare Dashboard 操作。"
echo "---"

 # --- 3. 清空 KV Namespace ---
echo "[3/$STEP_COUNT] 清空 KV Namespace '$KV_NAMESPACE_TITLE' (ID: $KV_NAMESPACE_ID)..."
# 假设 kv key list 默认输出适合 xargs (如果失败可能需要更复杂的解析)
mapfile -t KEY_LIST < <(wrangler kv key list --namespace-id "$KV_NAMESPACE_ID")
list_exit_code=$?
 if [ $list_exit_code -ne 0 ] && [ ${#KEY_LIST[@]} -eq 0 ]; then
    echo "  ❌ 错误：获取 KV Key 列表失败。请检查是否需要安装 'libatomic1' (sudo apt install libatomic1)?" >&2; ((FAIL_COUNT++));
elif [ ${#KEY_LIST[@]} -eq 0 ]; then
     echo "  ✅ KV Namespace '$KV_NAMESPACE_TITLE' 为空或不包含 Key，无需清空。"
else
     echo "  找到 ${#KEY_LIST[@]} 个 Key，正在删除..."
     # 使用 printf 和 xargs 处理可能包含特殊字符的 key
     printf "%s\n" "${KEY_LIST[@]}" | xargs -d '\n' wrangler kv key delete --namespace-id "$KV_NAMESPACE_ID" --batch-size=100 # 尝试增加 batch-size
     if [ $? -eq 0 ]; then
          echo "  ✅ KV Key 删除命令已执行。"
     else
          echo "  ❌ 错误：删除 KV Key 时发生错误 (可能是 libatomic 问题或 xargs 失败)。" >&2
          ((FAIL_COUNT++))
     fi
fi
echo "---"

# --- 4. 清空 Queue 消息 (使用 --force) ---
echo "[4/$STEP_COUNT] 清空 Queue '$QUEUE_NAME' 消息..."
if wrangler queues purge "$QUEUE_NAME" --force; then # 使用 --force 标志
    echo "  ✅ Queue '$QUEUE_NAME' 已成功清空。"
else
    echo "  ❌ 错误：清空 Queue '$QUEUE_NAME' 失败。" >&2
    ((FAIL_COUNT++))
fi
echo "---"

# --- 5. 重置 DO 状态 (保持不变) ---
# 注意：此步骤序号保持为 5，但总步骤数是 4 (因为 R2 跳过了)
# 为了避免混淆，将步骤序号改为基于 $STEP_COUNT
echo "[$STEP_COUNT/$STEP_COUNT] 重置 Durable Object 状态 (通过 API)..." # 使用 STEP_COUNT
reset_url="${API_WORKER_URL}${DO_RESET_ENDPOINT}"
echo "  调用端点: $reset_url"
if curl -sf -X POST "$reset_url" -H "Content-Type: application/json" -o /dev/null; then
    echo "  ✅ DO 重置请求已成功发送 (HTTP 2xx)。"
else
    echo "  ❌ 错误：发送 DO 重置请求失败 (HTTP 状态码非 2xx)。" >&2
    ((FAIL_COUNT++))
fi
echo "---"

# --- 最终总结 ---
echo "所有清理操作尝试完毕。"
if (( FAIL_COUNT > 0 )); then
    echo -e "\e[1;31m有 $FAIL_COUNT 个步骤失败或遇到错误，请检查上面的日志。\e[0m" >&2
    exit 1
else
    echo -e "\e[1;32m所有清理操作均已成功完成或确认无需操作。\e[0m"
    exit 0
fi
