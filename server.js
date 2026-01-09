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

let currentRate = 3.20;
async function updateRate() {
    try {
        const response = await axios.get('https://open.er-api.com/v6/latest/USD');
        if (response.data && response.data.rates && response.data.rates.ILS) {
            currentRate = response.data.rates.ILS;
            console.log(`Live Rate Updated: 1 USD = ${currentRate} ILS`);
        }
    } catch (e) {
        console.error('Rate API Error, using fallback 3.20:', e.message);
    }
}
updateRate();
setInterval(updateRate, 1000 * 60 * 60); // Update every hour

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
    ['product_name', 'txid', 'delivery_image', 'audit_logs', 'fulfillment_id', 'delivery_node', 'client_ip', 'client_ua', 'execution_time'].forEach(col => {
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
    .container { background: #0a0a0a; border: 1px solid #d4af37; padding: 40px; border-radius: 20px; box-shadow: 0 0 20px rgba(212, 175, 55, 0.1); max-width: 500px; width: 100%; text-align: center; }
    .logo { font-size: 2.5rem; font-weight: bold; color: #d4af37; text-shadow: 0 0 15px rgba(212, 175, 55, 0.3); margin-bottom: 30px; }
    input { width: 100%; padding: 15px; margin: 10px 0; background: #111; border: 1px solid #333; color: white; border-radius: 10px; font-family: sans-serif; }
    .summary-box { background: #111; padding: 15px; border-radius: 10px; margin: 20px 0; text-align: left; border-left: 4px solid #d4af37; }
    .btn { background: transparent; color: #d4af37; border: 1px solid #d4af37; padding: 15px 30px; border-radius: 50px; cursor: pointer; font-weight: bold; font-size: 1.1rem; transition: 0.3s; width: 100%; margin-top: 20px; }
    .btn:hover { background: #d4af37; color: #000; box-shadow: 0 0 30px #d4af37; }
    .note { font-size: 0.8rem; color: #888; margin-top: 10px; font-family: sans-serif; }
    .receipt-item { display: flex; justify-content: space-between; margin: 10px 0; font-family: sans-serif; }
</style>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&display=swap" rel="stylesheet">
`;

// דף הבית ותנאים
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));
app.get('/support', (req, res) => res.sendFile(path.join(__dirname, 'support.html')));

app.post('/api/support/send', async (req, res) => {
    const { name, email, orderId, message } = req.body;
    
    const mailOptions = {
        from: `"Support Ticket" <${process.env.EMAIL_USER}>`,
        to: 'seles@wolfgamingstore.net',
        replyTo: email,
        subject: `New Support Ticket from ${name}`,
        html: `
            <h2>New Support Request</h2>
            <p><b>Name:</b> ${name}</p>
            <p><b>Email:</b> ${email}</p>
            <p><b>Order ID:</b> ${orderId || 'N/A'}</p>
            <hr>
            <p><b>Message:</b></p>
            <p>${message}</p>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        res.send(`${commonStyles}<div class="container"><div class="logo">SENT!</div><p>Your request has been sent. We will contact you shortly.</p><a href="/support" class="btn">BACK</a></div>`);
    } catch (e) {
        res.status(500).send("Error sending message.");
    }
});

// 1. דף Checkout עם הטופס החדש
app.get('/checkout/:amount', (req, res) => {
    const rawAmount = req.params.amount;
    const amount = parseFloat(rawAmount);
    const isILS = req.query.curr === 'ILS';
    const productName = req.query.p || 'Gaming Product';
    
    if (isILS) {
        if (isNaN(amount) || amount < 100) {
            return res.status(400).send(`${commonStyles}<div class="container"><div class="logo">WOLF ERROR</div><p>Minimum order amount is 100 ILS.</p><a href="/" class="btn">BACK TO STORE</a></div>`);
        }
    } else {
        if (isNaN(amount) || amount < 31.00) {
            return res.status(400).send(`${commonStyles}<div class="container"><div class="logo">WOLF ERROR</div><p>Minimum order amount is $31.00 USD.</p><a href="/" class="btn">BACK TO STORE</a></div>`);
        }
    }

    let baseILS, feeILS, totalILS, totalUSD;
    
    if (isILS) {
        baseILS = amount;
        feeILS = amount * 0.02; 
        totalILS = baseILS + feeILS;
        totalUSD = (totalILS / currentRate).toFixed(2);
    } else {
        const feeVal = amount * 0.02;
        totalUSD = (amount + feeVal).toFixed(2);
        baseILS = (amount * currentRate);
        feeILS = (feeVal * currentRate);
    }

    const displayBase = isILS ? `${baseILS.toFixed(2)} ILS` : `$${amount.toFixed(2)} USD`;
    const displayService = isILS ? `${feeILS.toFixed(2)} ILS` : `$${(amount * 0.02).toFixed(2)} USD`;

    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Complete Your Purchase | WOLF GAMING</title>
            <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
            <style>
                :root { 
                    --gold: #d4af37; 
                    --black: #000000; 
                    --dark-grey: #0a0a0a;
                    --border: #1a1a1a;
                    --white: #ffffff; 
                    --text-muted: #888;
                }
                
                body { 
                    background: var(--black); 
                    color: var(--white); 
                    font-family: 'Inter', sans-serif; 
                    margin: 0; 
                    padding: 0; 
                    min-height: 100vh; 
                    box-sizing: border-box;
                }

                .checkout-layout {
                    display: grid;
                    grid-template-columns: 1fr 350px;
                    gap: 40px;
                    max-width: 1100px;
                    width: 95%;
                    margin: 60px auto;
                }

                .logo-area {
                    text-align: center;
                    margin-bottom: 40px;
                    grid-column: 1 / -1;
                }

                .logo-text {
                    font-family: 'Orbitron', sans-serif;
                    font-size: 2.2rem;
                    font-weight: 900;
                    color: var(--gold);
                    letter-spacing: 8px;
                    text-transform: uppercase;
                    text-shadow: 0 0 20px rgba(212, 175, 55, 0.2);
                }

                .card {
                    background: var(--dark-grey);
                    border: 1px solid var(--border);
                    border-radius: 20px;
                    padding: 35px;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
                    height: fit-content;
                }

                .tabs-container {
                    display: flex;
                    border-bottom: 1px solid var(--border);
                    margin-bottom: 30px;
                    gap: 20px;
                }

                .tab-btn {
                    background: none;
                    border: none;
                    color: var(--text-muted);
                    font-family: 'Orbitron', sans-serif;
                    font-size: 0.9rem;
                    font-weight: 700;
                    padding: 15px 5px;
                    cursor: pointer;
                    transition: all 0.3s ease;
                    position: relative;
                    text-transform: uppercase;
                    letter-spacing: 1px;
                }

                .tab-btn.active {
                    color: var(--gold);
                }

                .tab-btn.active::after {
                    content: '';
                    position: absolute;
                    bottom: -1px;
                    left: 0;
                    width: 100%;
                    height: 2px;
                    background: var(--gold);
                    box-shadow: 0 0 10px var(--gold);
                }

                .tab-content {
                    display: none;
                    animation: fadeIn 0.5s ease;
                }

                .tab-content.active {
                    display: block;
                }

                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(10px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                /* Crypto UI Styling */
                .crypto-info {
                    text-align: center;
                }

                .qr-container {
                    width: 180px;
                    height: 180px;
                    margin: 0 auto 25px;
                    background: #fff;
                    padding: 10px;
                    border-radius: 12px;
                    border: 4px solid var(--gold);
                    box-shadow: 0 0 20px rgba(212, 175, 55, 0.2);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .address-field {
                    background: #000;
                    border: 1px solid var(--border);
                    border-radius: 10px;
                    display: flex;
                    align-items: center;
                    padding: 12px 15px;
                    margin-bottom: 20px;
                    gap: 10px;
                }

                .address-text {
                    flex-grow: 1;
                    font-family: monospace;
                    font-size: 0.85rem;
                    color: #aaa;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                .copy-btn {
                    background: var(--gold);
                    border: none;
                    border-radius: 6px;
                    color: #000;
                    font-family: 'Orbitron', sans-serif;
                    font-size: 0.7rem;
                    font-weight: 900;
                    padding: 8px 12px;
                    cursor: pointer;
                    transition: 0.3s;
                }

                .copy-btn:hover {
                    filter: brightness(1.2);
                    box-shadow: 0 0 10px var(--gold);
                }

                .upload-area {
                    border: 2px dashed var(--border);
                    border-radius: 15px;
                    padding: 30px;
                    text-align: center;
                    transition: 0.3s;
                    cursor: pointer;
                    background: #050505;
                }

                .upload-area:hover {
                    border-color: var(--gold);
                    background: rgba(212, 175, 55, 0.05);
                }

                .upload-icon {
                    font-size: 2rem;
                    margin-bottom: 10px;
                    display: block;
                }

                .upload-label {
                    font-family: 'Orbitron', sans-serif;
                    font-size: 0.75rem;
                    color: var(--text-muted);
                    letter-spacing: 1px;
                }

                /* Summary Sidebar */
                .summary-card {
                    background: var(--dark-grey);
                    border: 1px solid var(--border);
                    border-radius: 20px;
                    padding: 30px;
                    position: sticky;
                    top: 100px;
                }

                .summary-title {
                    font-family: 'Orbitron', sans-serif;
                    font-size: 1.1rem;
                    font-weight: 700;
                    color: var(--gold);
                    margin-bottom: 25px;
                    text-transform: uppercase;
                    letter-spacing: 2px;
                }

                .summary-row {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 12px;
                    font-size: 0.9rem;
                }

                .summary-label { color: var(--text-muted); }
                .summary-value { color: var(--white); font-weight: 500; }

                /* Security Box Styling */
                .security-box {
                    margin-top: 20px;
                    padding: 20px;
                    background: rgba(212, 175, 55, 0.03);
                    border: 1px solid rgba(212, 175, 55, 0.1);
                    border-radius: 12px;
                }

                .security-item {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    margin-bottom: 12px;
                    font-size: 0.8rem;
                    color: #aaa;
                }

                .security-icon {
                    color: var(--gold);
                    font-size: 1rem;
                }

                .trust-logos {
                    display: flex;
                    justify-content: center;
                    gap: 20px;
                    margin-top: 20px;
                    padding-top: 15px;
                    border-top: 1px solid rgba(255,255,255,0.05);
                }

                .trust-logo {
                    height: 20px;
                    filter: grayscale(1) brightness(0) invert(1) sepia(1) saturate(5) hue-rotate(10deg);
                    opacity: 0.6;
                }

                .total-row {
                    margin-top: 20px;
                    padding-top: 20px;
                    border-top: 1px solid var(--border);
                    display: flex;
                    justify-content: space-between;
                    align-items: baseline;
                }

                .total-label {
                    font-family: 'Orbitron', sans-serif;
                    font-size: 0.9rem;
                    font-weight: 700;
                    color: var(--white);
                }

                .total-value {
                    font-family: 'Orbitron', sans-serif;
                    font-size: 1.6rem;
                    font-weight: 900;
                    color: var(--gold);
                }

                /* Widget Placeholder Styling */
                #payment-widget-container {
                    min-height: 400px;
                    background: #000;
                    border-radius: 12px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                }

                .spinner {
                    width: 45px;
                    height: 45px;
                    border: 3px solid rgba(212, 175, 55, 0.1);
                    border-top: 3px solid var(--gold);
                    border-radius: 50%;
                    animation: spin 1s cubic-bezier(0.4, 0, 0.2, 1) infinite;
                    margin-bottom: 20px;
                }

                @keyframes spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }

                .loading-msg {
                    font-family: 'Orbitron', sans-serif;
                    font-size: 0.75rem;
                    color: #555;
                    letter-spacing: 1.5px;
                    text-transform: uppercase;
                }

                .trust-badge {
                    text-align: center;
                    margin-top: 25px;
                    font-size: 0.65rem;
                    color: #333;
                    letter-spacing: 1px;
                    text-transform: uppercase;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    gap: 15px;
                }

                @media (max-width: 900px) {
                    .checkout-layout { grid-template-columns: 1fr; }
                    .summary-card { position: static; }
                }
            </style>
        </head>
        <body>
            <div class="checkout-layout">
                <div class="logo-area">
                    <div class="logo-text">WOLF GAMING</div>
                </div>

                <!-- Main Payment Column -->
                <div class="card">
                    <div class="tabs-container">
                        <button class="tab-btn active" onclick="switchTab('card')">Pay with Card</button>
                        <button class="tab-btn" onclick="switchTab('crypto')">Pay with Crypto</button>
                    </div>

                    <!-- Card Payment Content -->
                    <div id="card-content" class="tab-content active">
                        <div id="payment-widget-container">
                            <div class="spinner"></div>
                            <div class="loading-msg">Securely connecting to payment provider...</div>
                        </div>
                        <div class="trust-badge">
                            <span>SSL SECURED</span>
                            <span>•</span>
                            <span>DISCRETE BILLING</span>
                            <span>•</span>
                            <span>24/7 SUPPORT</span>
                        </div>
                    </div>

                    <!-- Crypto Payment Content -->
                    <div id="crypto-content" class="tab-content">
                        <div class="crypto-info">
                            <div class="qr-container">
                                <!-- QR Code Placeholder -->
                                <svg width="140" height="140" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M0 0H60V60H0V0ZM10 10V50H50V10H10Z" fill="#000"/>
                                    <path d="M80 0H140V60H80V0ZM90 10V50H130V10H90Z" fill="#000"/>
                                    <path d="M0 80H60V140H0V80ZM10 90V130H50V90H10Z" fill="#000"/>
                                    <rect x="25" y="25" width="10" height="10" fill="#000"/>
                                    <rect x="105" y="25" width="10" height="10" fill="#000"/>
                                    <rect x="25" y="105" width="10" height="10" fill="#000"/>
                                    <path d="M80 80H100V100H80V80Z" fill="#000"/>
                                    <path d="M120 120H140V140H120V120Z" fill="#000"/>
                                    <path d="M100 100H120V120H100V100Z" fill="#000"/>
                                    <path d="M120 80H140V100H120V80Z" fill="#000"/>
                                    <path d="M80 120H100V140H80V120Z" fill="#000"/>
                                </svg>
                            </div>
                            
                            <p class="summary-label" style="margin-bottom: 10px; font-size: 0.8rem; font-family: 'Orbitron';">Network: USDT (TRC20)</p>
                            <div class="address-field">
                                <span class="address-text" id="wallet-address">TMv7p8X9zY4kQ2mN5rS1wX0jL3hB6vF9gA</span>
                                <button class="copy-btn" onclick="copyAddress()">COPY</button>
                            </div>

                            <div class="upload-area" onclick="document.getElementById('proof-upload').click()">
                                <input type="file" id="proof-upload" style="display: none;">
                                <span class="upload-icon">📸</span>
                                <div class="upload-label">UPLOAD PROOF OF PAYMENT</div>
                                <p style="font-size: 0.6rem; color: #444; margin-top: 10px;">Drag and drop or click to upload screenshot</p>
                            </div>

                            <button class="btn" style="width: 100%; margin-top: 30px; border-radius: 12px;" onclick="alert('Checking transaction...')">VERIFY PAYMENT</button>
                        </div>
                    </div>
                </div>

                <!-- Summary Sidebar -->
                <div class="summary-card">
                    <div class="summary-title">Order Summary</div>
                    <div class="summary-row">
                        <span class="summary-label">Product</span>
                        <span class="summary-value">${productName}</span>
                    </div>
                    <div class="summary-row">
                        <span class="summary-label">Base Amount</span>
                        <span class="summary-value">${displayBase}</span>
                    </div>
                    <div class="summary-row">
                        <span class="summary-label">Platform Service</span>
                        <span class="summary-value">${displayService}</span>
                    </div>
                    
                    <div class="total-row">
                        <span class="total-label">Total to Pay</span>
                        <span class="total-value">$${totalUSD} USD</span>
                    </div>
                    
                    <p style="font-size: 0.65rem; color: #444; margin-top: 20px; line-height: 1.4;">
                        * 1 USD = ${currentRate.toFixed(3)} ILS (Live Rate Applied)
                    </p>

                    <!-- Security & Verification Box -->
                    <div class="security-box">
                        <div class="security-item">
                            <span class="security-icon">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                            </span>
                            <span>Instant ID Verification</span>
                        </div>
                        <div class="security-item">
                            <span class="security-icon">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><path d="M12 18h.01"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
                            </span>
                            <span>SMS 3D-Secure Protection</span>
                        </div>
                        <div class="security-item" style="margin-bottom: 0;">
                            <span class="security-icon">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                            </span>
                            <span>First-Time Purchase Guard</span>
                        </div>

                        <div class="trust-logos">
                            <img src="https://upload.wikimedia.org/wikipedia/commons/4/41/Visa_Logo.svg" alt="Visa Secure" class="trust-logo">
                            <img src="https://upload.wikimedia.org/wikipedia/commons/2/2a/Mastercard-logo.svg" alt="Mastercard ID Check" class="trust-logo">
                        </div>
                    </div>
                </div>
            </div>

            <script>
                function switchTab(tab) {
                    // Update buttons
                    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
                    event.target.classList.add('active');

                    // Update content
                    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
                    document.getElementById(tab + '-content').classList.add('active');
                }

                function copyAddress() {
                    const address = document.getElementById('wallet-address').innerText;
                    navigator.clipboard.writeText(address);
                    const btn = document.querySelector('.copy-btn');
                    btn.innerText = 'COPIED!';
                    setTimeout(() => btn.innerText = 'COPY', 2000);
                }
            </script>
        </body>
        </html>
    `);
});

// 2. עיבוד התשלום ויצירת חשבונית ב-NOWPayments
app.post('/api/process-payment', async (req, res) => {
    const { totalAmount, name, email, productName } = req.body;
    const orderId = 'WOLF_' + Date.now();
    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const clientUa = req.headers['user-agent'];

    try {
        const response = await axios.post('https://api.nowpayments.io/v1/invoice', {
            price_amount: totalAmount,
            price_currency: 'usd',
            pay_currency: 'usdttrc20',
            order_id: orderId,
            order_description: `${productName} for ${name}`,
            success_url: `${BASE_URL}/receipt?orderId=${orderId}&amount=${totalAmount}`,
            cancel_url: `${BASE_URL}/cancel`
        }, {
            headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
            timeout: 10000
        });

        const now = new Date();
        const initialLogs = JSON.stringify([
            `${now.toLocaleTimeString('he-IL', { hour12: false })} - Order Initialized`,
            `${new Date(now.getTime() + 2 * 60000).toLocaleTimeString('he-IL', { hour12: false })} - Sent to Fulfillment Node`
        ]);

        db.run("INSERT INTO transactions (order_id, payment_id, amount, customer_name, customer_email, product_name, status, audit_logs, client_ip, client_ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", 
               [orderId, response.data.id, totalAmount, name, email, productName, 'fulfilling', initialLogs, clientIp, clientUa]);
        
        // Send Telegram Notification
        sendTelegram(`<b>NEW ORDER: ${orderId}</b>\nProduct: ${productName}\nCustomer: ${name}\nAmount: $${totalAmount}\n<i>Auto-delivery process started...</i>`).catch(e => {});

        // Schedule Auto-Completion (4 to 8 minutes)
        const delayMinutes = Math.floor(Math.random() * (8 - 4 + 1) + 4);
        setTimeout(() => {
            completeOrder(orderId, 'Auto');
        }, delayMinutes * 60000);

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
            <h1 style="color:#00ff88;">✅ Order Confirmed!</h1>
            <div class="summary-box" style="border-color:#00ff88; text-align:center;">
                <p style="margin:5px 0; color:#888;">Reference Number:</p>
                <h3 style="margin:5px 0; color:#00f2ff;">${orderId}</h3>
                <hr style="border:0; border-top:1px solid #333; margin:15px 0;">
                <p style="margin:5px 0; color:#888;">Total Assets:</p>
                <h2 style="margin:5px 0;">$${amount}</h2>
            </div>
            <p style="font-family:sans-serif; line-height:1.6;">
                Your digital assets are being finalized and will be delivered within minutes.
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
    completeOrder(orderId, 'Manual');
    res.json({ success: true });
});

// Helper to complete order (auto or manual)
async function completeOrder(orderId, method = 'Auto') {
    const internalLogicId = 'DLV-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const fulfillmentId = 'TX-' + crypto.randomBytes(3).toString('hex').toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
    const nodes = ['Central-Auth-Server-01', 'Node-Express-West-04', 'Global-Fulfillment-Node-09', 'Wolf-Secure-Node-07'];
    const deliveryNode = nodes[Math.floor(Math.random() * nodes.length)];
    
    db.get("SELECT * FROM transactions WHERE order_id = ?", [orderId], async (err, order) => {
        if (err || !order || order.status === 'completed') return;

        const now = new Date();
        const timeStr = now.toLocaleTimeString('he-IL', { hour12: false });
        const logEntry = `${timeStr} - ${method} Delivery Confirmation (${internalLogicId})`;
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
            db.run("UPDATE transactions SET status = 'completed', audit_logs = ?, fulfillment_id = ?, delivery_node = ?, execution_time = ? WHERE order_id = ?", 
                   [JSON.stringify(logs), orderId, fulfillmentId, deliveryNode, now.toISOString()]);
            sendTelegram(`✅ הזמנה ${orderId} הושלמה (${method})`).catch(e => {});
        } catch (mailError) {
            console.error('Email Error:', mailError);
        }
    });
}

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
                <div style="margin-top: 20px; color: #555; font-size: 0.8rem;">
                    * All amounts are in USD. Internal logic: 1 USD = 3.25 ILS for reference.
                </div>
                <a href="/" class="btn" style="margin-top:30px;">BACK TO STORE</a>
            </div>
        `;
        res.send(html);
    });
});

app.get('/api/admin/proof/:orderId', (req, res) => {
    const auth = req.query.token; // Using query token for opening in new tab
    if (auth !== ADMIN_PASS) return res.status(401).send("Unauthorized");

    const { orderId } = req.params;
    db.get("SELECT * FROM transactions WHERE order_id = ?", [orderId], (err, order) => {
        if (err || !order) return res.status(404).send("Order not found");

        const verificationCode = `${order.order_id}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
        const deliveryTime = order.status === 'completed' ? new Date(order.created_at).toLocaleString('he-IL') : 'PENDING';

        const html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <style>
                    body { font-family: 'Courier New', Courier, monospace; color: #000; padding: 50px; line-height: 1.6; }
                    .document { border: 2px solid #000; padding: 40px; max-width: 800px; margin: 0 auto; }
                    .header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 20px; margin-bottom: 30px; }
                    .logo-text { font-size: 28px; font-weight: bold; letter-spacing: 5px; }
                    .title { font-size: 18px; margin-top: 10px; text-decoration: underline; }
                    .field { margin: 15px 0; font-size: 16px; }
                    .field b { width: 200px; display: inline-block; }
                    .footer { margin-top: 50px; border-top: 1px dashed #000; padding-top: 20px; font-size: 14px; }
                    .watermark { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-45deg); font-size: 100px; color: rgba(0,0,0,0.05); pointer-events: none; z-index: -1; }
                    @media print { .no-print { display: none; } }
                </style>
                <title>Proof of Delivery - ${order.order_id}</title>
            </head>
            <body>
                <div class="no-print" style="text-align:center; margin-bottom:20px;">
                    <button onclick="window.print()">Print Document / Save as PDF</button>
                </div>
                <div class="document">
                    <div class="watermark">VERIFIED</div>
                    <div class="header">
                        <div class="logo-text">WOLF GAMING</div>
                        <div class="title">DIGITAL DELIVERY VERIFICATION</div>
                    </div>

                    <div class="field"><b>Order ID:</b> ${order.order_id}</div>
                    <div class="field"><b>Date:</b> ${new Date(order.created_at).toLocaleDateString('he-IL')}</div>
                    <div class="field"><b>Amount:</b> $${order.amount}</div>
                    <div class="field"><b>Customer Email:</b> ${order.customer_email}</div>
                    <div class="field"><b>Delivery Timestamp:</b> ${deliveryTime}</div>
                    <div class="field"><b>Product:</b> ${order.product_name || 'N/A'}</div>

                    <div class="footer">
                        <p><b>Verification Code:</b> ${verificationCode}</p>
                        <p><b>Status:</b> <span style="text-transform:uppercase;">${order.status === 'completed' ? 'VERIFIED' : 'PENDING'}</span></p>
                        <p><b>Settlement:</b> Weekly with supplier.</p>
                        <p style="margin-top:20px; font-size:10px; color:#555;">This document serves as digital proof of service fulfillment. Generated by WOLF-GATE Internal System.</p>
                    </div>
                </div>
            </body>
            </html>
        `;
        res.send(html);
    });
});

app.get('/api/admin/pod/:orderId', (req, res) => {
    const auth = req.query.token;
    if (auth !== ADMIN_PASS) return res.status(401).send("Unauthorized");

    const { orderId } = req.params;
    db.get("SELECT * FROM transactions WHERE order_id = ?", [orderId], (err, order) => {
        if (err || !order) return res.status(404).send("Order not found");

        const logs = JSON.parse(order.audit_logs || '[]');
        
        const html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <style>
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f4f7f6; color: #333; padding: 40px; }
                    .certificate { background: white; max-width: 800px; margin: 0 auto; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); overflow: hidden; border: 1px solid #ddd; position: relative; }
                    .cert-header { background: #050505; color: #00f2ff; padding: 30px; text-align: center; border-bottom: 5px solid #bc13fe; }
                    .cert-body { padding: 40px; }
                    .cert-title { font-size: 24px; font-weight: bold; margin-bottom: 30px; text-transform: uppercase; letter-spacing: 2px; text-align: center; color: #111; }
                    .data-row { display: flex; border-bottom: 1px solid #eee; padding: 12px 0; }
                    .data-label { width: 220px; font-weight: bold; color: #666; text-transform: uppercase; font-size: 13px; }
                    .data-value { flex: 1; font-family: monospace; font-size: 15px; color: #000; }
                    .status-box { margin-top: 30px; background: #f9f9f9; padding: 20px; border-radius: 8px; border: 1px solid #eee; }
                    .status-step { display: flex; align-items: center; margin-bottom: 10px; }
                    .status-dot { width: 10px; height: 10px; background: #00ff88; border-radius: 50%; margin-right: 15px; }
                    .cert-footer { background: #f9f9f9; padding: 20px; text-align: center; font-size: 12px; color: #999; border-top: 1px solid #eee; }
                    .btn-print { background: #00f2ff; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-weight: bold; margin-bottom: 20px; }
                    @media print { .btn-print { display: none; } body { padding: 0; background: white; } .certificate { box-shadow: none; border: 2px solid #000; } }
                </style>
                <title>Digital Delivery Certificate - ${order.order_id}</title>
            </head>
            <body>
                <div style="text-align: center;">
                    <button class="btn-print" onclick="window.print()">EXPORT AS PDF / PRINT</button>
                </div>
                <div class="certificate">
                    <div class="cert-header">
                        <h1 style="margin:0; letter-spacing:5px;">WOLF GAMING</h1>
                        <p style="margin:5px 0 0 0; font-size:12px; opacity:0.8;">PREMIUM DIGITAL SERVICES FULFILLMENT</p>
                    </div>
                    <div class="cert-body">
                        <div class="cert-title">Digital Delivery Certificate</div>
                        
                        <div class="data-row">
                            <div class="data-label">Order Reference</div>
                            <div class="data-value">${order.order_id}</div>
                        </div>
                        <div class="data-row">
                            <div class="data-label">Fulfillment ID</div>
                            <div class="data-value">${order.fulfillment_id || 'N/A'}</div>
                        </div>
                        <div class="data-row">
                            <div class="data-label">Delivery Node</div>
                            <div class="data-value">${order.delivery_node || 'N/A'}</div>
                        </div>
                        <div class="data-row">
                            <div class="data-label">Execution Time</div>
                            <div class="data-value">${order.execution_time ? new Date(order.execution_time).toLocaleString('en-US') : 'N/A'}</div>
                        </div>
                        <div class="data-row">
                            <div class="data-label">Customer Email</div>
                            <div class="data-value">${order.customer_email}</div>
                        </div>
                        <div class="data-row" style="border:none;">
                            <div class="data-label">Client Footprint</div>
                            <div class="data-value" style="font-size:11px; line-height:1.4;">
                                IP: ${order.client_ip || 'Hidden'}<br>
                                UA: ${order.client_ua || 'Unknown'}
                            </div>
                        </div>

                        <div class="status-box">
                            <div style="font-weight:bold; margin-bottom:15px; font-size:14px; color:#555;">STATUS TRANSACTION LOG</div>
                            <div class="status-step"><div class="status-dot"></div> <span>[AUTHORIZATION] - ASSETS VERIFIED</span></div>
                            <div class="status-step"><div class="status-dot"></div> <span>[FULFILLMENT] - SENT TO DELIVERY NODE</span></div>
                            <div class="status-step"><div class="status-dot" style="background:#bc13fe;"></div> <span>[DELIVERED] - ASSETS TRANSFERRED</span></div>
                        </div>
                    </div>
                    <div class="cert-footer">
                        This is an automated delivery confirmation. All transactions are logged and verified against server execution nodes.
                        <br>Verification Hash: ${crypto.createHash('md5').update(order.order_id + order.fulfillment_id).digest('hex')}
                    </div>
                </div>
            </body>
            </html>
        `;
        res.send(html);
    });
});

app.listen(PORT, () => console.log(`WOLF GAMING READY ON PORT ${PORT}`));
