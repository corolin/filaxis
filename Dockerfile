FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY bin ./bin
RUN bun build bin/filaxis-mcp.ts --target node --outfile dist/bin/filaxis-mcp.js

FROM node:22-alpine
RUN apk add --no-cache openssh-client
WORKDIR /app
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist/bin/filaxis-mcp.js ./dist/bin/filaxis-mcp.js
ENTRYPOINT ["node", "/app/dist/bin/filaxis-mcp.js"]
