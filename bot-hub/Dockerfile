FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/data BOTHUB_TRUST_PROXY=1
# Claude Code CLI, used by the "claude-code" provider. Auth at runtime via the
# CLAUDE_CODE_OAUTH_TOKEN env var (from `claude setup-token`); never bake a token in.
RUN npm install -g @anthropic-ai/claude-code && claude --version
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY config.example.json ./
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "src/server.js"]
