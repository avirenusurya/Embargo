FROM node:22-slim
# ffmpeg splits long audio/video uploads into chunks within the Whisper API size limit (Part 11.6).
# curl is used by scripts/demo-start.sh to wait for the server before seeding the demo workspace.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
EXPOSE 8787
CMD ["npx", "tsx", "src/main.ts"]
