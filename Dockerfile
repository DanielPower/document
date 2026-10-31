# ---- build ---------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm run build

# ---- runtime -------------------------------------------------------------
FROM node:22-bookworm-slim
# Extra Tesseract languages, e.g. --build-arg TESSERACT_LANGS="fra deu"
ARG TESSERACT_LANGS=""
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ocrmypdf tesseract-ocr tesseract-ocr-eng tesseract-ocr-osd poppler-utils \
      $(for l in $TESSERACT_LANGS; do echo tesseract-ocr-$l; done) \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data CONSUME_DIR=/consume TZ=UTC
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
VOLUME ["/data", "/consume"]
EXPOSE 8080
USER node
CMD ["node", "server/dist/index.js"]
