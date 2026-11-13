# Root-level Dockerfile — build context is the repo root.
# Mirrors backend/Dockerfile with paths adjusted for the monorepo layout.
FROM node:22-slim AS build
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json backend/tsconfig.build.json ./
COPY backend/src ./src
RUN npm run build && node -e "require('fs').cpSync('src/db/migrations','dist/db/migrations',{recursive:true})" && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
