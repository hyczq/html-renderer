#!/usr/bin/env bash
# 部署/更新 html-renderer 到远程宿主机（tar over ssh + docker compose）
#
# 用法：
#   HOST=root@your-server ./deploy.sh
#   HOST=root@your-server KEY=~/.ssh/id_ed25519 REMOTE_DIR=/opt/html-renderer ./deploy.sh
#
# 环境变量：
#   HOST        必填，SSH 目标，例如 root@192.0.2.10
#   KEY         SSH 私钥路径，默认 ~/.ssh/id_ed25519
#   REMOTE_DIR  远程部署目录，默认 /opt/html-renderer
set -euo pipefail

HOST="${HOST:?请设置 HOST，例如 HOST=root@your-server ./deploy.sh}"
KEY="${KEY:-$HOME/.ssh/id_ed25519}"
REMOTE_DIR="${REMOTE_DIR:-/opt/html-renderer}"

cd "$(dirname "$0")"

tar czf - \
  --exclude=./data \
  --exclude=./node_modules \
  --exclude=./.git \
  --exclude=./.env \
  --exclude=./docker-compose.override.yml \
  --exclude=./deploy.sh \
  . \
  | ssh -i "$KEY" \
      -o IdentitiesOnly=yes \
      -o ConnectTimeout=25 \
      "$HOST" "
        set -e
        mkdir -p '$REMOTE_DIR'
        tar xzf - -C '$REMOTE_DIR'
        mkdir -p '$REMOTE_DIR/data/pastes'
        chown -R 10001:10001 '$REMOTE_DIR/data'
        cd '$REMOTE_DIR'
        docker compose up -d --build
        docker compose ps
      "
