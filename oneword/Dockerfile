FROM node:22-alpine

# Контекст сборки — корень репозитория (см. docker-compose.yml): серверу нужен общий lib/.
# Каталог игры лежит в /app/oneword, lib — рядом в /app/lib, так require("../lib/…") работает так же, как локально.
WORKDIR /app/oneword
COPY oneword/package.json oneword/package-lock.json ./
RUN npm ci --omit=dev

COPY lib /app/lib
COPY oneword/ ./
RUN mkdir -p /app/state

# Куча V8 ниже лимита контейнера (mem_limit 128m) — как у соседних игр (см. auction/Dockerfile)
ENV NODE_ENV=production PORT=4000 DUMP_FILE=/app/state/rooms.json NODE_OPTIONS=--max-old-space-size=96
EXPOSE 4000
CMD ["node", "server.js"]
