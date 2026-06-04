FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# Copy package files first for Docker caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the entire project
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Install Playwright browsers
RUN npx playwright install chromium

# Build TypeScript
RUN npm run build

EXPOSE 3000

CMD ["node", "dist/server.js"]