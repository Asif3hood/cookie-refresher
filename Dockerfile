# ─────────────────────────────────────────────────────────────
# cookie-refresher — Puppeteer + Express sidecar
# Base: Debian slim (Chromium's libs are easier to install than on Alpine)
# ─────────────────────────────────────────────────────────────
FROM node:20-slim

# ── 1. Install Chromium + all shared libraries it needs ──────
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    wget \
 && rm -rf /var/lib/apt/lists/*

# ── 2. Tell Puppeteer to use system Chromium ────────────────
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

# ── 2b. Fix crashpad: Chromium needs a writable dir ─────────
# Point XDG dirs to /tmp so any user can write
ENV XDG_CONFIG_HOME=/tmp/.chromium \
    XDG_CACHE_HOME=/tmp/.chromium \
    HOME=/tmp

WORKDIR /app

# ── 3. Install dependencies (layer cache friendly) ───────────
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── 4. Copy app source ──────────────────────────────────────
COPY . .

# ── 5. Create user + writable dirs BEFORE dropping privileges ─
RUN groupadd -r app && useradd -r -g app -m -d /home/app app \
 && mkdir -p /tmp/.chromium /home/app \
 && chmod -R 1777 /tmp/.chromium \
 && chown -R app:app /app /home/app
USER app

# ── 6. Render injects $PORT (default 10000 for local docker) ─
ENV PORT=10000 \
    HOST=0.0.0.0
EXPOSE 10000

# ── 7. Start ────────────────────────────────────────────────
CMD ["node", "cookie-refresher.js"]