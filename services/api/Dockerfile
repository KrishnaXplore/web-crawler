# Build from the repo root:  docker build -f services/api/Dockerfile .
# Multi-stage (docs/phase7.md Step C): compile in a full toolchain layer, run
# compiled JS as non-root in a slim layer — no TypeScript/tsx in the runtime image.

FROM node:22-alpine AS build
RUN npm install -g pnpm@9.15.0
WORKDIR /app
# The pnpm lockfile spans the whole workspace, so the whole workspace is the
# context (.dockerignore keeps node_modules/dist/.env out).
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
# Drop dev dependencies; the symlinked workspace layout stays intact.
RUN pnpm prune --prod

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app .
USER node
EXPOSE 3000
CMD ["node", "services/api/dist/index.js"]
