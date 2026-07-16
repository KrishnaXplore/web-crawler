FROM node:20-alpine AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM mcr.microsoft.com/playwright:v1.49.1-jammy AS runner
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/services/renderer/package.json ./services/renderer/
COPY --from=builder /app/services/renderer/dist ./services/renderer/dist
COPY --from=builder /app/packages ./packages

EXPOSE 9465
CMD ["node", "services/renderer/dist/index.js"]
