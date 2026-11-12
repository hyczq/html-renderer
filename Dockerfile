FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

COPY package.json server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN addgroup -g 10001 -S app \
 && adduser -S -u 10001 -G app app \
 && mkdir -p /data/pastes /data/blobs /data/users /data/index/user-pastes \
 && chown -R app:app /data /app

USER app
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1

CMD ["node", "server.js"]
