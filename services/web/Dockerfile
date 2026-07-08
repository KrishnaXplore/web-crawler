# Build from the repo root:  docker build -f services/web/Dockerfile .
# vite build → static files served by nginx, which proxies /api to the api
# container (services/web/nginx.conf) — no CORS, same shape as dev.

FROM node:22-alpine AS build
RUN npm install -g pnpm@9.15.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @crawler/web build

FROM nginx:1.27-alpine
COPY services/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/services/web/dist /usr/share/nginx/html
EXPOSE 80
