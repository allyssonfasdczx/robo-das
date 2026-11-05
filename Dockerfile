FROM mcr.microsoft.com/playwright:v1.48.2-jammy
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.mjs .
CMD ["npm", "start"]
