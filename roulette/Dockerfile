FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/state

# Куча V8 ниже лимита контейнера (mem_limit 256m) — почему, см. auction/Dockerfile
ENV NODE_ENV=production PORT=3100 DUMP_FILE=/app/state/rooms.json NODE_OPTIONS=--max-old-space-size=192
EXPOSE 3100
CMD ["node", "server.js"]
