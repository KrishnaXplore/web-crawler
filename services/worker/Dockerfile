# Build from the repo root:  docker build -f services/worker/Dockerfile .
# Same shape as the api image (docs/phase7.md Step C): compile with the full
# toolchain, run compiled JS as non-root, nothing but production deps at runtime.

FROM node:22-alpine AS build
RUN npm install -g pnpm@9.15.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
RUN pnpm prune --prod

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app .
USER node
EXPOSE 9464
CMD ["node", "services/worker/dist/index.js"]
