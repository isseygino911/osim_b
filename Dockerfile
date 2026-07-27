# Production image for the Express backend only (no client code, no dev tooling).
# Build context is this repo (server/) itself.
# Build: docker build -t osim-backend .
# Run:   docker run -p 8787:8787 -v $(pwd)/../data:/app/data osim-backend
FROM node:22-slim

WORKDIR /app/server

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# The server resolves its data dir as ../data relative to server/ (see
# models/*.model.js), i.e. a sibling of the app code, not inside it. Create it here
# and mount a volume over it for persistence across container restarts/rebuilds.
RUN mkdir -p /app/data

# The start script uses --env-file=.env; keep the file present even if empty (see
# root CLAUDE.md) so the container boots with no Gemini/Tradier key configured.
# Pass real values with `docker run -e` or an env_file at deploy time — never bake
# secrets into the image.
RUN touch .env

EXPOSE 8787

CMD ["npm", "run", "start"]
