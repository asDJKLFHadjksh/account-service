# account-service

Standalone account and authentication service for kuhyakuya.com.

## Stack
- Node.js + Express
- SQLite (`sqlite3`)
- Vanilla HTML/CSS/JS

## Setup
1. Copy `.env.example` to `.env` and update secrets.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Initialize database:
   ```bash
   npm run db:init
   ```
4. Start server:
   ```bash
   npm start
   ```

## Routes
Implements register, login, forgot password (OTP), reset authenticator via recovery code, username change with password+OTP, logout, and dashboard protections.
