require('dotenv').config();
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const app = express();

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

app.use((req, res, next) => {
    res.setHeader('Bypass-Tunnel-Reminder', 'true');
    next();
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_IDS = [process.env.TELEGRAM_CHAT_ID_1, process.env.TELEGRAM_CHAT_ID_2].filter(Boolean);
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;

const db = new sqlite3.Database('./database.sqlite');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT,
        payment_id TEXT,
        amount TEXT,
        customer_name TEXT,
        customer_email TEXT,
        status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

const sendTelegram = async (message) => {
    if (!TELEGRAM_TOKEN || CHAT_IDS.length === 0) return;
    for (const chatId of CHAT_IDS) {
        try {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: chatId,
                text: message,
                parse_mode: 'HTML'
            }, { timeout: 5000 });
        } catch (e) { console.error('Telegram Error:', e.message); }
    }
};

const commonStyles = `
<style>
    body { background: #050505; color: white; font-family: 'Orbitron', sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .container { background: #0a0a0a; border: 1px solid #00f2ff; padding: 40px; border-radius: 20px; box-shadow: 0 0 20px rgba(0, 242, 255, 0.2); max-width: 500px; width: 100%; text-align: center; }
    .logo { font-size: 2.5rem; font-weight: bold; color: #00f2ff; text-shadow: 0 0 15px #00f2ff; margin-bottom: 30px; }
    input { width: 100%; padding: 15px; margin: 10px 0; background: #111; border: 1px solid #333; color: white; border-radius: 10px; font-family: sans-serif; }
    .fee-box { background: #111; padding: 15px; border-radius: 10px; margin: 20px 0; text-align: left; border-left: 4px solid #bc13fe; }
    .btn { background: transparent; color: #00f2ff; border: 1px solid #00f2ff; padding: 15px 30px; border-radius: 50px; cursor: pointer; font-weight: bold; font-size: 1.1rem; transition: 0.3s; width: 100%; margin-top: 20px; }
    .btn:hover { background: #00f2ff; color: #000; box-shadow: 0 0 30px #00f2ff; }
    .note { font-size: 0.8rem; color: #888; margin-top: 10px; font-family: sans-serif; }
    .receipt-item { display: flex; justify-content: space-between; margin: 10px 0; font-family: sans-serif; }
</style>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&display=swap" rel="stylesheet">
`;

// דף הבית ותנאים
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));

// 1. דף Checkout עם הטופס החדש
app.get('/checkout/:amount', (req, res) => {
    const amount = parseFloat(req.params.amount);
    const fee = (amount * 0.01).toFixed(2);
    const total = (amount + parseFloat(fee)).toFixed(2);

    res.send(`
        ${commonStyles}
        <div class="container">
            <div class="logo">WOLF GAMING</div>
            <h2>Checkout</h2>
            <form action="/api/process-payment" method="POST">
                <input type="hidden" name="baseAmount" value="${amount}">
                <input type="text" name="name" placeholder="Full Name" required>
                <input type="email" name="email" placeholder="Email Address" required>
                <div class="note">Your digital code will be sent to this email.</div>
                
                <div class="fee-box">
                    <div class="receipt-item"><span>Base Amount:</span> <span>₪${amount}</span></div>
                    <div class="receipt-item"><span>Secure Processing Fee (1%):</span> <span>₪${fee}</span></div>
                    <hr style="border:0; border-top:1px solid #333;">
                    <div class="receipt-item" style="font-weight:bold; color:#00f2ff;"><span>Total to Pay:</span> <span>₪${total}</span></div>
                </div>
                
                <button type="submit" class="btn">PROCEED TO PAYMENT</button>
            </form>
        </div>
    `);
});

// 2. עיבוד התשלום ויצירת חשבונית ב-NOWPayments
app.post('/api/process-payment', async (req, res) => {
    const { baseAmount, name, email } = req.body;
    const totalIls = (parseFloat(baseAmount) * 1.01).toFixed(2);
    const orderId = 'WOLF_' + Date.now();

    try {
        let rate = 3.8;
        try {
            const rateRes = await axios.get('https://api.exchangerate-api.com/v4/latest/USD', { timeout: 5000 });
            rate = rateRes.data.rates.ILS;
        } catch (e) { console.warn("Using fallback rate"); }

        const amountUsd = (parseFloat(totalIls) / rate).toFixed(2);

        const response = await axios.post('https://api.nowpayments.io/v1/invoice', {
            price_amount: amountUsd,
            price_currency: 'usd',
            pay_currency: 'usdttrc20',
            order_id: orderId,
            order_description: `Gaming Credits for ${name}`,
            success_url: `${BASE_URL}/receipt?orderId=${orderId}&amount=${totalIls}`,
            cancel_url: `${BASE_URL}/cancel`
        }, {
            headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
            timeout: 10000
        });

        db.run("INSERT INTO transactions (order_id, payment_id, amount, customer_name, customer_email, status) VALUES (?, ?, ?, ?, ?, ?)", 
               [orderId, response.data.id, totalIls, name, email, 'waiting']);
        
        sendTelegram(`<b>🆕 הזמנה חדשה: ${orderId}</b>\nלקוח: ${name}\nסכום: ₪${totalIls}`).catch(e => {});

        res.redirect(response.data.invoice_url);
    } catch (error) {
        res.status(500).send("Error creating payment. Please try again.");
    }
});

// 3. דף קבלה מקצועי (Receipt)
app.get('/receipt', (req, res) => {
    const { orderId, amount } = req.query;
    res.send(`
        ${commonStyles}
        <div class="container">
            <div class="logo">WOLF GAMING</div>
            <h1 style="color:#00ff88;">✅ Payment Confirmed!</h1>
            <div class="fee-box" style="border-color:#00ff88; text-align:center;">
                <p style="margin:5px 0; color:#888;">Order Number:</p>
                <h3 style="margin:5px 0; color:#00f2ff;">${orderId}</h3>
                <hr style="border:0; border-top:1px solid #333; margin:15px 0;">
                <p style="margin:5px 0; color:#888;">Amount Paid:</p>
                <h2 style="margin:5px 0;">₪${amount}</h2>
            </div>
            <p style="font-family:sans-serif; line-height:1.6;">
                Please <b>send a screenshot of this receipt</b> to your agent to receive your points/code.
            </p>
            <a href="/" class="btn">RETURN TO STORE</a>
        </div>
    `);
});

app.get('/cancel', (req, res) => res.send(`${commonStyles}<div class="container"><div class="logo" style="color:#ff4444;">WOLF GAMING</div><h1>❌ Payment Cancelled</h1><a href="/" class="btn" style="color:#ff4444; border-color:#ff4444;">BACK TO HOME</a></div>`));

app.listen(PORT, () => console.log(`WOLF GAMING READY ON PORT ${PORT}`));
