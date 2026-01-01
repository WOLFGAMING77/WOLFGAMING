require('dotenv').config();
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const app = express();

// הגדרות Render ופורט
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || 'https://thirty-rooms-shop.loca.lt';

// Middleware
app.use(cors());
app.use(express.json());

// Header לעקיפת אזהרות טונל (שימושי גם לבדיקות מקומיות)
app.use((req, res, next) => {
    res.setHeader('Bypass-Tunnel-Reminder', 'true');
    next();
});

// משתני סביבה
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_HOST = process.env.EMAIL_HOST || '127.0.0.1';
const EMAIL_PORT = process.env.EMAIL_PORT || 1025;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_IDS = [process.env.TELEGRAM_CHAT_ID_1, process.env.TELEGRAM_CHAT_ID_2].filter(Boolean);

// מסד נתונים SQLite
const db = new sqlite3.Database('./database.sqlite');
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_id TEXT, amount TEXT, status TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

// הגדרת Nodemailer פנימי
const transporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: false,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    tls: { rejectUnauthorized: false }
});

// פונקציה לשליחת דיווח לטלגרם
const sendTelegram = async (message) => {
    for (const chatId of CHAT_IDS) {
        try {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: chatId,
                text: message,
                parse_mode: 'HTML'
            });
        } catch (e) { console.error('Telegram Error:', e.message); }
    }
};

// דפים ראשיים
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));

// --- דפי תגובה מעוצבים WOLF GAMING ---

const styles = `
    <style>
        body { background: #050505; color: white; font-family: sans-serif; text-align: center; padding-top: 100px; }
        .logo { font-size: 2.5rem; font-weight: bold; color: #00f2ff; text-shadow: 0 0 10px #00f2ff; margin-bottom: 20px; }
        .btn { display: inline-block; color: #00f2ff; border: 1px solid #00f2ff; padding: 12px 30px; text-decoration: none; border-radius: 50px; transition: 0.3s; margin-top: 30px; font-weight: bold; }
        .btn:hover { background: #00f2ff; color: #000; box-shadow: 0 0 20px #00f2ff; }
        .status-card { background: #111; padding: 40px; border-radius: 20px; display: inline-block; border: 1px solid #333; }
    </style>
`;

app.get('/success', (req, res) => {
    res.send(`
        ${styles}
        <div class="status-card">
            <div class="logo">WOLF GAMING</div>
            <h1 style="color:#00ff88;">✅ Payment Successful!</h1>
            <p>Your credits are being processed. Check your email/telegram for confirmation.</p>
            <a href="/" class="btn">Back to Store</a>
        </div>
    `);
});

app.get('/cancel', (req, res) => {
    res.send(`
        ${styles}
        <div class="status-card">
            <div class="logo" style="color:#ff4444; text-shadow: 0 0 10px #ff4444;">WOLF GAMING</div>
            <h1 style="color:#ff4444;">❌ Payment Cancelled</h1>
            <p>The transaction was not completed. You can try again at any time.</p>
            <a href="/" class="btn" style="color:#ff4444; border-color:#ff4444;">Back to Store</a>
        </div>
    `);
});

// --- לוגיקת תשלום ---

app.get('/pay/:amount', async (req, res) => {
    const amountIls = req.params.amount;
    try {
        const rateRes = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
        const amountUsd = (parseFloat(amountIls) / rateRes.data.rates.ILS).toFixed(2);

        const response = await axios.post('https://api.nowpayments.io/v1/invoice', {
            price_amount: amountUsd,
            price_currency: 'usd',
            pay_currency: 'usdttrc20',
            order_id: 'WOLF_' + Date.now(),
            order_description: 'WOLF GAMING Credits',
            success_url: `${BASE_URL}/success`,
            cancel_url: `${BASE_URL}/cancel`
        }, {
            headers: { 
                'x-api-key': process.env.NOWPAYMENTS_API_KEY, 
                'Content-Type': 'application/json' 
            }
        });

        db.run("INSERT INTO transactions (payment_id, amount, status) VALUES (?, ?, ?)", 
               [response.data.id, amountIls, 'waiting']);

        await sendTelegram(`<b>🆕 הזמנה נוצרה - WOLF GAMING</b>\nסכום: ₪${amountIls}\nממתין לתשלום ב-USDT.`);

        res.redirect(response.data.invoice_url);

    } catch (error) {
        console.error("--- NOWPAYMENTS ERROR ---");
        console.error(error.response ? error.response.data : error.message);
        res.status(500).send("Request Failed");
    }
});

app.listen(PORT, () => console.log(`WOLF GAMING SERVER READY ON PORT ${PORT}`));
