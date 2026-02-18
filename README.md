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


## Redeem Code API
- `GET /api/redeem/batch`: ambil ACTIVE batch milik user, atau auto-generate 1 batch gratis (sekali seumur akun).
- `POST /api/redeem/claim`: claim 1 code dari ACTIVE batch menjadi ID Tag real di tabel `tags`.
- `POST /api/redeem/overwrite`: overwrite ACTIVE batch (wajib `redeem_credits > 0`), me-release code OFFERED lama lalu membuat batch baru.

Catatan: `code12` disimpan sebagai 12 digit numerik (`XXXXXXXXXXXX`) dan ditampilkan ke UI sebagai format `XXXX-XXXX-XXXX`.
