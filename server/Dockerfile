#  Cuepull backend
# Node + yt-dlp + ffmpeg, all in one image.
FROM node:20-slim

# System deps: ffmpeg (audio conversion) + python/curl (to fetch yt-dlp binary)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       python3 \
       curl \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install the latest yt-dlp standalone binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Install node deps first (layer caching, only re-runs if package.json changes)
COPY package*.json ./
RUN npm ci --omit=dev

# App source
COPY . .

# Downloads land here; mounted as a volume in docker-compose so files persist.
RUN mkdir -p downloads

EXPOSE 3001

CMD ["node", "index.js"]
