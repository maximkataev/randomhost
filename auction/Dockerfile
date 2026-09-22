FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/state

ENV NODE_ENV=production PORT=3000 DUMP_FILE=/app/state/rooms.json
EXPOSE 3000
CMD ["node", "server.js"]
