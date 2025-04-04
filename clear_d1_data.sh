#!/bin/bash

# 脚本：清空指定 D1 数据库中所有用户表的数据 (保留表结构)
# 警告：此操作将删除目标数据库内所有用户自定义表中的所有行！请谨慎使用！

# --- 配置 ---
DATABASE_NAME="d1-imgn-20240402" # 需要清空数据的 D1 数据库名称

echo "本脚本将尝试清空数据库 '$DATABASE_NAME' 中所有用户表的数据。"
echo "表结构本身将被保留。"
echo -e "\n!!! \e[1;31m警告：这是一个破坏性操作，将删除所有数据且无法撤销！\e[0m !!!" # 红色警告
echo "--------------------------------------------------"

# --- 检查依赖工具 ---
if ! command -v wrangler &> /dev/null; then
    echo "错误：未找到 'wrangler' 命令。请先安装 Wrangler CLI。" >&2
    exit 1
fi
if ! command -v jq &> /dev/null; then
    echo "错误：未找到 'jq' 命令。请安装 (例如: sudo apt install jq)。" >&2
    exit 1
fi

# --- 确认 Cloudflare 凭证已配置 (可选但推荐) ---
if [[ -z "$CLOUDFLARE_ACCOUNT_ID" && -z "$TF_VAR_cloudflare_account_id" ]]; then
    echo "警告：未检测到 Cloudflare Account ID 环境变量。请确保已配置，否则后续命令可能失败。" >&2
fi

# --- **极其重要**的用户确认 ---
# 要求用户输入数据库名称以确认，增加安全性
read -p "为防止误操作，请输入要清空数据的数据库名称 ('$DATABASE_NAME'): " confirm_db_name
if [[ "$confirm_db_name" != "$DATABASE_NAME" ]]; then
    echo "输入的数据库名称不匹配，操作已取消。"
    exit 1
fi

read -p "请再次确认删除 '$DATABASE_NAME' 中所有用户表的数据? (输入 'yes' 继续执行): " confirm_action
if [[ "${confirm_action,,}" != "yes" ]]; then # 转换为小写并检查
    echo "操作已取消。"
    exit 0
fi

echo "---"
echo "正在获取数据库 '$DATABASE_NAME' 中的用户表列表..."

# --- 获取用户表列表 ---
# 使用 --json 参数获取易于解析的输出，然后用 jq 提取表名
# 排除 sqlite_* (SQLite内部表), _cf_* (Cloudflare内部表), d1_migrations (Wrangler迁移表)
mapfile -t TABLE_LIST < <(wrangler d1 execute "$DATABASE_NAME" --remote --json --command="SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations';" | jq -r '.[].results[]? | .name')

# 检查是否成功获取到列表或是否有表
# (注意：如果命令本身失败，wrangler会返回非零退出码，脚本可能在此之前就因 set -e 等设置而退出)
if [ $? -ne 0 ]; then
    echo "错误：获取表列表失败，请检查 wrangler 命令输出或网络连接。" >&2
    exit 1
fi

if [ ${#TABLE_LIST[@]} -eq 0 ]; then
    echo "在数据库 '$DATABASE_NAME' 中未找到需要清空的用户表。"
    exit 0
fi

echo "将要清空以下表的数据: ${TABLE_LIST[*]}"
echo "--- 开始清空 ---"

# --- 循环执行 DELETE FROM 语句 ---
FAIL_COUNT=0
SUCCESS_COUNT=0
for table_name in "${TABLE_LIST[@]}"; do
    echo "正在清空表 '$table_name'..."
    # 使用双引号确保表名正确处理特殊字符 (虽然 SQLite 通常不要求)
    delete_command="DELETE FROM \"$table_name\";"

    # 执行删除命令
    if output=$(wrangler d1 execute "$DATABASE_NAME" --remote --command="$delete_command" 2>&1); then
        echo "  ✅ 成功清空表 '$table_name'."
        ((SUCCESS_COUNT++))
    else
        echo "  ❌ 错误：清空表 '$table_name' 失败。" >&2
        echo "     Wrangler 输出: $output" >&2 # 打印错误输出
        ((FAIL_COUNT++))
    fi
done

echo "--- 清空操作完成 ---"
echo "总结：成功清空 ${SUCCESS_COUNT} 个表，失败 ${FAIL_COUNT} 个表。"

if (( FAIL_COUNT > 0 )); then
    echo "请检查上面的错误信息。" >&2
    exit 1 # 以非零状态退出表示有错误
else
    echo "数据库 '$DATABASE_NAME' 中所有用户表的数据已成功清空。"
    exit 0 # 以零状态退出表示成功
fi