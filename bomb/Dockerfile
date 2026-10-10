FROM node:22-alpine

# Контекст сборки — корень репозитория (см. docker-compose.yml): серверу нужен общий lib/.
# Каталог игры лежит в /app/bomb, lib — рядом в /app/lib, так require("../lib/…") работает так же, как локально.
WORKDIR /app/bomb
COPY bomb/package.json bomb/package-lock.json ./
RUN npm ci --omit=dev

COPY lib /app/lib
COPY bomb/ ./
RUN mkdir -p /app/state

# Куча V8 ниже лимита контейнера (mem_limit 128m) — почему, см. auction/Dockerfile
ENV NODE_ENV=production PORT=3300 DUMP_FILE=/app/state/rooms.json NODE_OPTIONS=--max-old-space-size=96
EXPOSE 3300
CMD ["node", "server.js"]
