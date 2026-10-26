FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY packages/core packages/core
COPY apps/api apps/api
RUN pnpm install --no-frozen-lockfile --filter @fisika/api...
WORKDIR /app/apps/api
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
USER node
CMD ["node", "src/server.ts"]
