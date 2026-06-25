FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV HOST=0.0.0.0
ENV PORT=7860
ENV DATA_DIR=/tmp/davicool-data

RUN mkdir -p /tmp/davicool-data

EXPOSE 7860

CMD ["npm", "start"]
