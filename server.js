require('dotenv').config();
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const app = express();

// פורט וכתובת בסיס (דינמי ל-Render)
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// עקיפת אזהרות טונל
app.use((req, res, next) => {
    res.setHeader('Bypass-Tunnel-Reminder', 'true');
    next();
});

// משתני סביבה
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_IDS = [process.env.TELEGRAM_CHAT_ID_1, process.env.TELEGRAM_CHAT_ID_2].filter(Boolean);
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;

// מסד נתונים
const db = new sqlite3.Database('./database.sqlite');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id TEXT,
        amount TEXT,
        status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
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

// דפים
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));

// דפי הצלחה וביטול
const statusStyles = `
    <style>
        body { background: #050505; color: white; font-family: sans-serif; text-align: center; padding-top: 100px; }
        .logo { font-size: 3rem; font-weight: bold; color: #00f2ff; text-shadow: 0 0 15px #00f2ff; margin-bottom: 20px; }
        .btn { display: inline-block; color: #00f2ff; border: 2px solid #00f2ff; padding: 15px 40px; text-decoration: none; border-radius: 50px; transition: 0.3s; margin-top: 30px; font-weight: bold; font-size: 1.2rem; }
        .btn:hover { background: #00f2ff; color: #000; box-shadow: 0 0 30px #00f2ff; }
    </style>
`;

app.get('/success', (req, res) => {
    res.send(`${statusStyles}<div class="logo">WOLF GAMING</div><h1 style="color:#00ff88;">✅ תשלום התקבל בהצלחה!</h1><p>הקרדיטים שלך בטעינה. תודה שבחרת בנו.</p><a href="/" class="btn">חזרה לחנות</a>`);
});

app.get('/cancel', (req, res) => {
    res.send(`${statusStyles}<div class="logo" style="color:#ff4444; text-shadow: 0 0 15px #ff4444;">WOLF GAMING</div><h1 style="color:#ff4444;">❌ התשלום בוטל</h1><p>העסקה לא הושלמה. ניתן לנסות שוב בכל עת.</p><a href="/" class="btn" style="color:#ff4444; border-color:#ff4444;">חזרה לחנות</a>`);
});

// לוגיקת Checkout ישירה
app.get('/checkout/:amount', async (req, res) => {
    const amountIls = req.params.amount;
    
    try {
        // משיכת שער דולר עדכני
        const rateRes = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
        const amountUsd = (parseFloat(amountIls) / rateRes.data.rates.ILS).toFixed(2);

        // יצירת חשבונית ב-NOWPayments
        const response = await axios.post('https://api.nowpayments.io/v1/invoice', {
            price_amount: amountUsd,
            price_currency: 'usd',
            pay_currency: 'usdttrc20',
            order_id: 'WOLF_' + Date.now(),
            order_description: 'Gaming Credits',
            success_url: `${BASE_URL}/success`,
            cancel_url: `${BASE_URL}/cancel`
        }, {
            headers: { 
                'x-api-key': NOWPAYMENTS_API_KEY, 
                'Content-Type': 'application/json' 
            }
        });

        // שמירה למסד נתונים
        db.run("INSERT INTO transactions (payment_id, amount, status) VALUES (?, ?, ?)", 
               [response.data.id, amountIls, 'waiting']);

        // דיווח לטלגרם
        await sendTelegram(`<b>🆕 הזמנה נוצרה: ₪${amountIls}</b>\nהלקוח מועבר לדף התשלום המאובטח.`);

        // הפניה מיידית לדף התשלום
        res.redirect(response.data.invoice_url);

    } catch (error) {
        console.error("NOWPayments Error:", error.response ? error.response.data : error.message);
        res.status(500).send("שגיאה במעבר לתשלום. אנא וודא שכל המפתחות מוגדרים ב-Render.");
    }
});

app.listen(PORT, () => console.log(`WOLF GAMING READY ON PORT ${PORT}`));
