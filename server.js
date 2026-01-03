require('dotenv').config();
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const app = express();

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'wolf2026';

// יצירת תיקיית העלאות אם לא קיימת
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));
app.use(express.static(path.join(__dirname)));

app.use((req, res, next) => {
    res.setHeader('Bypass-Tunnel-Reminder', 'true');
    next();
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_IDS = [process.env.TELEGRAM_CHAT_ID_1, process.env.TELEGRAM_CHAT_ID_2].filter(Boolean);
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || '127.0.0.1',
    port: process.env.EMAIL_PORT || 1025,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    tls: { rejectUnauthorized: false }
});

const db = new sqlite3.Database('./database.sqlite');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT,
        payment_id TEXT,
        amount TEXT,
        customer_name TEXT,
        customer_email TEXT,
        product_name TEXT,
        status TEXT,
        txid TEXT,
        delivery_image TEXT,
        audit_logs TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // הוספת עמודות אם הטבלה כבר קיימת
    ['product_name', 'txid', 'delivery_image', 'audit_logs'].forEach(col => {
        db.run(`ALTER TABLE transactions ADD COLUMN ${col} TEXT`, () => {});
    });
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
    const productName = req.query.p || 'Gaming Product';
    const fee = (amount * 0.01).toFixed(2);
    const total = (amount + parseFloat(fee)).toFixed(2);

    res.send(`
        ${commonStyles}
        <div class="container">
            <div class="logo">WOLF GAMING</div>
            <h2>Checkout</h2>
            <p style="color:#888;">Product: <b style="color:#00f2ff;">${productName}</b></p>
            <form action="/api/process-payment" method="POST">
                <input type="hidden" name="baseAmount" value="${amount}">
                <input type="hidden" name="productName" value="${productName}">
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
    const { baseAmount, name, email, productName } = req.body;
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
            order_description: `${productName} for ${name}`,
            success_url: `${BASE_URL}/receipt?orderId=${orderId}&amount=${totalIls}`,
            cancel_url: `${BASE_URL}/cancel`
        }, {
            headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
            timeout: 10000
        });

        const initialLog = JSON.stringify([`${new Date().toISOString()} - Order Created`]);
        db.run("INSERT INTO transactions (order_id, payment_id, amount, customer_name, customer_email, product_name, status, audit_logs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", 
               [orderId, response.data.id, totalIls, name, email, productName, 'pending', initialLog]);
        
        sendTelegram(`<b>🆕 הזמנה חדשה: ${orderId}</b>\nמוצר: ${productName}\nלקוח: ${name}\nסכום: ₪${totalIls}`).catch(e => {});

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

// --- ADMIN DASHBOARD ---

app.get('/admin-wolf-gate', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.post('/api/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASS) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false });
    }
});

app.get('/api/admin/orders', (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== ADMIN_PASS) return res.status(401).send();

    db.all("SELECT * FROM transactions ORDER BY created_at DESC", (err, rows) => {
        if (err) return res.status(500).send(err.message);
        res.json(rows);
    });
});

app.post('/api/admin/update-status', (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== ADMIN_PASS) return res.status(401).send();

    const { orderId, status } = req.body;
    const now = new Date().toLocaleTimeString('he-IL', { hour12: false });
    const logEntry = `${now} - Status changed to ${status}`;

    db.get("SELECT audit_logs FROM transactions WHERE order_id = ?", [orderId], (err, row) => {
        let logs = [];
        try {
            logs = row.audit_logs ? JSON.parse(row.audit_logs) : [];
        } catch(e) {}
        logs.push(logEntry);

        db.run("UPDATE transactions SET status = ?, audit_logs = ? WHERE order_id = ?", 
               [status, JSON.stringify(logs), orderId], (err) => {
            if (err) return res.status(500).send(err.message);
            res.json({ success: true });
        });
    });
});

app.post('/api/admin/update-delivery', upload.single('image'), (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== ADMIN_PASS) return res.status(401).send();

    const { orderId, txid } = req.body;
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

    let query = "UPDATE transactions SET txid = ?" + (imageUrl ? ", delivery_image = ?" : "") + " WHERE order_id = ?";
    let params = imageUrl ? [txid, imageUrl, orderId] : [txid, orderId];

    db.run(query, params, (err) => {
        if (err) return res.status(500).send(err.message);
        res.json({ success: true, imageUrl });
    });
});

app.post('/api/admin/mark-delivered', async (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== ADMIN_PASS) return res.status(401).send();

    const { orderId } = req.body;
    const internalLogicId = 'DLV-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const now = new Date().toISOString();

    db.get("SELECT * FROM transactions WHERE order_id = ?", [orderId], async (err, order) => {
        if (err || !order) return res.status(404).send("Order not found");

        const logEntry = `${new Date().toLocaleTimeString('he-IL', { hour12: false })} - Marked as Delivered (${internalLogicId})`;
        let logs = [];
        try { logs = JSON.parse(order.audit_logs || '[]'); } catch(e) {}
        logs.push(logEntry);

        // Send Email
        const mailOptions = {
            from: `"WOLF GAMING" <${process.env.EMAIL_USER}>`,
            to: order.customer_email,
            subject: `✅ Order Delivered: ${order.product_name}`,
            html: `
                <div style="background:#050505; color:white; padding:40px; font-family:sans-serif; border:1px solid #00f2ff; border-radius:15px;">
                    <h1 style="color:#00f2ff; text-align:center;">WOLF GAMING</h1>
                    <h2 style="text-align:center;">Delivery Confirmation</h2>
                    <p>Hello <b>${order.customer_name}</b>,</p>
                    <p>Your order for <b>${order.product_name}</b> has been successfully processed and added to your Account ID.</p>
                    <div style="background:#111; padding:20px; border-radius:10px; margin:20px 0; border-left:4px solid #bc13fe;">
                        <p style="margin:5px 0;"><b>Order #:</b> ${order.order_id}</p>
                        <p style="margin:5px 0;"><b>Internal Logic ID:</b> ${internalLogicId}</p>
                        <p style="margin:5px 0;"><b>Status:</b> DELIVERED</p>
                    </div>
                    <p style="color:#888; font-size:0.9rem;">Thank you for choosing WOLF GAMING. If you have any questions, contact our support.</p>
                </div>
            `
        };

        try {
            await transporter.sendMail(mailOptions);
            db.run("UPDATE transactions SET status = 'completed', audit_logs = ? WHERE order_id = ?", 
                   [JSON.stringify(logs), orderId], (err) => {
                if (err) return res.status(500).send(err.message);
                res.json({ success: true, internalId: internalLogicId });
            });
        } catch (mailError) {
            console.error('Email Error:', mailError);
            res.status(500).send("Order updated but email failed.");
        }
    });
});

app.get('/delivery-logs-wolf', (req, res) => {
    db.all("SELECT order_id, customer_email, created_at, status FROM transactions WHERE status = 'completed' ORDER BY created_at DESC", (err, rows) => {
        if (err) return res.status(500).send(err.message);
        
        let html = `
            ${commonStyles}
            <div class="container" style="max-width:900px;">
                <div class="logo">DELIVERY LOGS</div>
                <table style="width:100%; border-collapse:collapse; margin-top:20px; color:white; font-family:sans-serif;">
                    <thead>
                        <tr style="background:#111; color:#00f2ff; text-align:left;">
                            <th style="padding:15px;">Order #</th>
                            <th style="padding:15px;">Customer Email</th>
                            <th style="padding:15px;">Delivery Time</th>
                            <th style="padding:15px;">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map(r => `
                            <tr style="border-bottom:1px solid #222;">
                                <td style="padding:12px;">${r.order_id}</td>
                                <td style="padding:12px;">${r.customer_email}</td>
                                <td style="padding:12px;">${new Date(r.created_at).toLocaleString('he-IL')}</td>
                                <td style="padding:12px;"><span style="color:#00ff88; font-weight:bold;">SUCCESS</span></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
                <a href="/" class="btn" style="margin-top:30px;">BACK TO STORE</a>
            </div>
        `;
        res.send(html);
    });
});

app.listen(PORT, () => console.log(`WOLF GAMING READY ON PORT ${PORT}`));
