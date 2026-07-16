FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS builder
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
# pnpm deploy produces a self-contained, production-only directory for just this
# package — workspace deps resolved as real copies, devDependencies (typescript,
# tsx, vitest, ...) excluded. Verified: `pnpm prune --prod` alone left typescript
# behind in this workspace; deploy is pnpm's purpose-built command for this exact
# problem and was confirmed to actually exclude it (phase7.md: "no TS toolchain
# in the runtime image").
RUN pnpm --filter=@crawler/api deploy --prod /prod/api

FROM base AS runner
WORKDIR /app
COPY --from=builder --chown=node:node /prod/api ./

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
