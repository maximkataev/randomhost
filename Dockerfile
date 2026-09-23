FROM nginx:1.27-alpine

COPY . /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx-limits.conf /etc/nginx/conf.d/00-limits.conf

# `COPY . /usr/share/nginx/html` тащит в раздаваемый каталог и сами конфиги: до этой строки
# https://randomhost.online/nginx.conf и /docker-compose.yml открывались снаружи и показывали
# внутренние порты, имена контейнеров, значения limit_req и путь к .env с ключом судьи.
# В .dockerignore их не вынести — COPY выше их же и берёт, поэтому убираем после копирования.
RUN rm -f /usr/share/nginx/html/nginx.conf \
          /usr/share/nginx/html/nginx-limits.conf \
          /usr/share/nginx/html/Dockerfile \
          /usr/share/nginx/html/docker-compose.yml