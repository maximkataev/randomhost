FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/state

# Куча V8 ограничена ниже лимита контейнера (mem_limit 256m). По умолчанию Node внутри контейнера
# ставил предел кучи в 259 МБ — то есть выше самого лимита, и всплеск памяти заканчивался не сборкой
# мусора, а SIGKILL от ядра: без SIGTERM дамп не успевал записаться. 192 МБ кучи + ~40 МБ накладных
# укладываются в лимит, и под давлением процесс собирает мусор вместо того, чтобы быть убитым.
ENV NODE_ENV=production PORT=3000 DUMP_FILE=/app/state/rooms.json NODE_OPTIONS=--max-old-space-size=192
EXPOSE 3000
CMD ["node", "server.js"]
