FROM node:20-alpine AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM nginx:alpine AS runner
# nginx.conf proxies /api/* to the api container (same-origin, no CORS — the
# production shape from architecture-v2 §2 / phase5d). Without it the containerized
# dashboard has nowhere to send its API calls.
COPY services/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/services/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
