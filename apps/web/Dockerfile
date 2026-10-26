FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY apps/web apps/web
RUN pnpm install --no-frozen-lockfile --filter @fisika/web... && pnpm --filter @fisika/web build
WORKDIR /app/apps/web
ENV NODE_ENV=production
EXPOSE 3000
USER node
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
