FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/state

# Куча V8 ниже лимита контейнера (mem_limit 128m) — почему, см. auction/Dockerfile
ENV NODE_ENV=production PORT=3500 DUMP_FILE=/app/state/rooms.json NODE_OPTIONS=--max-old-space-size=96
EXPOSE 3500
CMD ["node", "server.js"]
