FROM node:22-alpine

# Контекст сборки — корень репозитория (см. docker-compose.yml): серверу нужен общий lib/.
# Каталог игры лежит в /app/blackjack, lib — рядом в /app/lib, так require("../lib/…") работает так же, как локально.
WORKDIR /app/blackjack
COPY blackjack/package.json blackjack/package-lock.json ./
RUN npm ci --omit=dev

COPY lib /app/lib
COPY blackjack/ ./
RUN mkdir -p /app/state

# Куча V8 ниже лимита контейнера (mem_limit 128m) — как у соседних игр (см. oneword/Dockerfile)
ENV NODE_ENV=production PORT=4100 DUMP_FILE=/app/state/rooms.json NODE_OPTIONS=--max-old-space-size=96
EXPOSE 4100
CMD ["node", "server.js"]
