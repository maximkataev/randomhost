FROM node:22-alpine

# Контекст сборки — корень репозитория (см. docker-compose.yml): серверу нужен общий lib/.
# Каталог игры лежит в /app/roulette, lib — рядом в /app/lib, так require("../lib/…") работает так же, как локально.
WORKDIR /app/roulette
COPY roulette/package.json roulette/package-lock.json ./
RUN npm ci --omit=dev

COPY lib /app/lib
COPY roulette/ ./
RUN mkdir -p /app/state

# Куча V8 ниже лимита контейнера (mem_limit 256m) — почему, см. auction/Dockerfile
ENV NODE_ENV=production PORT=3100 DUMP_FILE=/app/state/rooms.json NODE_OPTIONS=--max-old-space-size=192
EXPOSE 3100
CMD ["node", "server.js"]
