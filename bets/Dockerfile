FROM node:22-alpine

# Контекст сборки — корень репозитория (см. docker-compose.yml): серверу нужны общий lib/ и bets-shared.js (список реакций).
# Каталог игры лежит в /app/bets, lib и bets-shared.js — рядом в /app, так require("../lib/…") работает так же, как локально.
WORKDIR /app/bets
COPY bets/package.json bets/package-lock.json ./
RUN npm ci --omit=dev

COPY lib /app/lib
COPY bets-shared.js /app/bets-shared.js
COPY bets/ ./
RUN mkdir -p /app/state

# Куча V8 ниже лимита контейнера (mem_limit 256m) — почему, см. auction/Dockerfile
ENV NODE_ENV=production PORT=4300 DUMP_FILE=/app/state/rooms.json NODE_OPTIONS=--max-old-space-size=192
EXPOSE 4300
CMD ["node", "server.js"]
