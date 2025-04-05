#!/bin/bash

# 脚本：统一清理 imgn 项目在 Cloudflare 中产生的数据 (版本：跳过 R2 清理)
# 清理 D1 表数据, KV 键值对, Queue 消息, 并重置 DO 状态
# !!! R2 清理需手动操作 !!!
# !!! 警告：此脚本执行破坏性操作，但会保留资源本身 !!!

# --- 配置 ---
D1_DATABASE_NAME="d1-imgn-20240402"
R2_BUCKET_NAME="r2-imgn-20240402" # R2 名称，仅用于提示
QUEUE_NAME="imgn-queue-sync-tasks-20240402"
KV_NAMESPACE_ID="735f5c8008a64addb2b94dd097876ae9"
KV_NAMESPACE_TITLE="imgn-kv-cache-20240402"
API_WORKER_URL="https://imgn-api-worker.53.workers.dev"
DO_RESET_ENDPOINT="/reset-sync-do"

echo "本脚本将尝试清理以下 imgn 项目资源中的 *数据*："
echo "  - D1 数据库: $D1_DATABASE_NAME (清空所有用户表中的行)"
echo "  - R2 存储桶: $R2_BUCKET_NAME (>>> 本脚本将跳过 R2 清理 <<<)" # <--- 明确提示跳过
echo "  - KV 命名空间: $KV_NAMESPACE_TITLE (删除所有键值对)"
echo "  - Queue: $QUEUE_NAME (清除所有消息)"
echo "  - Durable Object 状态: 通过 API ($API_WORKER_URL$DO_RESET_ENDPOINT) 重置"
echo ""
echo -e "!!! \e[1;31m警告：此操作不可逆，将删除数据！资源本身将被保留。\e[0m !!!"
echo -e "!!! \e[1;33m提示: 如果 KV 清理步骤失败并提示 'libatomic.so.1' 错误, 请先运行: sudo apt update && sudo apt install libatomic1 -y\e[0m !!!"
echo "--------------------------------------------------"

# --- 检查依赖工具 ---
all_tools_found=true
# D1 需要 jq, KV/Queue/DO 需要 wrangler, curl, xargs
for cmd in wrangler jq curl xargs; do 
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
# 在确认提示中也说明不包含 R2
read -p $'!!! 请再次确认是否要执行以上所有数据清理操作 (不含 R2)?\n按 \e[1;32mEnter\e[0m 或输入 \e[1;32my/Y\e[0m 确认，输入其他任意字符取消: ' confirm_action
confirm_action_lower=${confirm_action,,}
if [[ -n "$confirm_action" && "$confirm_action_lower" != "y" ]]; then
    echo "操作已取消。"
    exit 0
fi

echo "--- 开始执行清理操作 (跳过 R2) ---"
FAIL_COUNT=0
# 总步骤数现在是 4 (D1, KV, Queue, DO)
STEP_COUNT=4 

# --- 1. 清空 D1 表数据 ---
echo "[1/$STEP_COUNT] 清空 D1 数据库 '$D1_DATABASE_NAME' 用户表数据..."
if ! command -v jq &> /dev/null; then echo "错误: D1 清理需要 'jq'。"; ((FAIL_COUNT++)); else
    mapfile -t D1_TABLE_LIST < <(wrangler d1 execute "$D1_DATABASE_NAME" --remote --json --command="SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations';" | jq -r '.[].results[]? | .name')
    list_exit_code=$? 
    if [ $list_exit_code -ne 0 ] && [ ${#D1_TABLE_LIST[@]} -eq 0 ]; then echo "  ⚠️ 获取 D1 表列表失败或未找到用户表。"; 
    elif [ ${#D1_TABLE_LIST[@]} -eq 0 ]; then echo "  ✅ D1 中没有用户表。"; 
    else 
        echo "  将清空表: ${D1_TABLE_LIST[*]}"; d1_fail_flag=0; 
        for table_name in "${D1_TABLE_LIST[@]}"; do echo "    清空表 '$table_name'..."; if ! wrangler d1 execute "$D1_DATABASE_NAME" --remote --command="DELETE FROM \"$table_name\";" > /dev/null 2>&1; then echo "    ❌ 错误：清空表 '$table_name' 失败。" >&2; d1_fail_flag=1; fi; done; 
        if [ $d1_fail_flag -eq 0 ]; then echo "  ✅ D1 用户表数据已清空。"; else ((FAIL_COUNT++)); fi; 
    fi; 
fi
echo "---"

# --- 2. 清空 R2 (明确跳过) ---
# 步骤序号保持连续性，但标记为跳过
echo "[2/$STEP_COUNT] 清空 R2 存储桶 '$R2_BUCKET_NAME' 对象... (已跳过)" 
echo "  ℹ️ 此脚本不执行 R2 对象清理。如有需要，请通过 Cloudflare Dashboard 手动操作。"
echo "---"

 # --- 3. 清空 KV Namespace ---
# 步骤显示序号调整为 3 / 总数 4
echo "[3/$STEP_COUNT] 清空 KV Namespace '$KV_NAMESPACE_TITLE' (ID: $KV_NAMESPACE_ID)..." 
mapfile -t KEY_LIST < <(wrangler kv key list --namespace-id "$KV_NAMESPACE_ID")
list_exit_code=$?
 if [ $list_exit_code -ne 0 ] && [ ${#KEY_LIST[@]} -eq 0 ]; then
    echo "  ❌ 错误：获取 KV Key 列表失败。请检查 'libatomic1' 是否已安装?" >&2; ((FAIL_COUNT++));
elif [ ${#KEY_LIST[@]} -eq 0 ]; then
     echo "  ✅ KV Namespace '$KV_NAMESPACE_TITLE' 为空。"
else
     echo "  找到 ${#KEY_LIST[@]} 个 Key，正在删除..."
     # 移除无效的 --batch-size 参数
     printf "%s\n" "${KEY_LIST[@]}" | xargs -d '\n' wrangler kv key delete --namespace-id "$KV_NAMESPACE_ID" 
     if [ $? -eq 0 ]; then
          echo "  ✅ KV Key 删除命令已执行。"
     else
          echo "  ❌ 错误：删除 KV Key 时发生错误。" >&2; ((FAIL_COUNT++));
     fi
fi
echo "---"

# --- 4. 清空 Queue 消息 ---
# 步骤显示序号调整为 4 / 总数 4
echo "[4/$STEP_COUNT] 清空 Queue '$QUEUE_NAME' 消息..." 
if wrangler queues purge "$QUEUE_NAME" --force; then # 使用 --force
    echo "  ✅ Queue '$QUEUE_NAME' 已成功清空。"
else
    echo "  ❌ 错误：清空 Queue '$QUEUE_NAME' 失败。" >&2; ((FAIL_COUNT++));
fi
echo "---"

# --- 5. 重置 DO 状态 ---
# 步骤显示序号调整为 5 / 总数 5 ？为了逻辑清晰，还是按实际执行步骤编号
# 将总步骤改为 4，这里就是最后一步
echo "[4/$STEP_COUNT] 重置 Durable Object 状态 (通过 API)..." # <--- 调整了这里的步骤号
reset_url="${API_WORKER_URL}${DO_RESET_ENDPOINT}"
echo "  调用端点: $reset_url"
if curl -sf -X POST "$reset_url" -H "Content-Type: application/json" -o /dev/null; then
    echo "  ✅ DO 重置请求已成功发送 (HTTP 2xx)。"
else
    echo "  ❌ 错误：发送 DO 重置请求失败 (HTTP 状态码非 2xx)。" >&2; ((FAIL_COUNT++));
fi
echo "---"

# --- 最终总结 ---
echo "所有清理操作尝试完毕 (R2 手动)。"
if (( FAIL_COUNT > 0 )); then
    echo -e "\e[1;31m有 $FAIL_COUNT 个步骤失败或遇到错误，请检查上面的日志。\e[0m" >&2
    exit 1
else
    echo -e "\e[1;32m所有脚本执行的清理操作均已成功完成或确认无需操作。\e[0m"
    exit 0
fi
