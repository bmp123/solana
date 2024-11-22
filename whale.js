const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');

// Telegram bot token
const TOKEN = '7914968186:AAFLh2nGgM4SYUGKjeJCi0lD7mufqshi_Ik';
const bot = new TelegramBot(TOKEN, { polling: true });

const RPC_SERVERS = [
    'https://lb.drpc.org/ogrpc?network=solana&dkey=AucD83vOV0uOkfFDGvxXXNXjB72Zp10R76g-FhW5UfFk',
    'https://summer-quaint-dream.solana-mainnet.quiknode.pro/9898a29e57e62e92e6e06f89d40c6e7c85d19121',
    'https://api.mainnet-beta.solana.com'
];
let currentRpcIndex = 0;
let connection = new Connection('https://lb.drpc.org/ogrpc?network=solana&dkey=AucD83vOV0uOkfFDGvxXXNXjB72Zp10R76g-FhW5UfFk', {
    maxSupportedTransactionVersion: 0,
});
// Paths to files
const WHALES_FILE = path.resolve(__dirname, 'whales.json');
const USERS_FILE = path.resolve(__dirname, 'users.json');
const delay = 2000
// Safe file operations
function safeReadFileSync(filePath, defaultValue = []) {
    if (fs.existsSync(filePath)) {
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (error) {
            console.error(`Error reading file ${filePath}:`, error.message);
            return defaultValue;
        }
    }
    return defaultValue;
}

function safeWriteFileSync(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error(`Error writing to file ${filePath}:`, error.message);
    }
}

// Load users and whales
let users = safeReadFileSync(USERS_FILE);
let whales = safeReadFileSync(WHALES_FILE);

// Map to store subscriptions
const subscriptions = new Map();

// Save whales and users
function saveWhalesToFile() {
    safeWriteFileSync(WHALES_FILE, whales);
}

function saveUsersToFile() {
    safeWriteFileSync(USERS_FILE, users);
}

// Add a queue for RPC requests
const requestQueue = [];
let isProcessingQueue = false;

// Обработчик запросов с очередью и задержкой
async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (requestQueue.length > 0) {
        const { fn, resolve, reject } = requestQueue.shift();
        try {
            const result = await fn();
            resolve(result);
        } catch (error) {
            if (error.response && error.response.status === 429) {
                const retryAfter = parseInt(error.response.headers['retry-after']) || delay;
                console.warn(`Превышен лимит запросов. Повтор через ${retryAfter} мс.`);
                await new Promise((r) => setTimeout(r, retryAfter));
                requestQueue.unshift({ fn, resolve, reject });
            } else {
                reject(error);
            }
        }
        await new Promise((r) => setTimeout(r, delay));
    }

    isProcessingQueue = false;
    // cleanupOldData();
}

function addToQueue(fn) {
    return new Promise((resolve, reject) => {
        requestQueue.push({ fn, resolve, reject });
        processQueue();
    });
}

// Command to register the user
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (!users.includes(chatId)) {
        users.push(chatId);
        saveUsersToFile();
        console.log(`New user registered: ${chatId}`);
    }
    bot.sendMessage(chatId, 'Welcome to the Whale Tracker bot! Use /hookwhale, /releasewhale, or /listwhales.');
});
// Расчет потраченных SOL
async function calculateSolSpent(tx) {
    let totalSolSpent = 0;

    if (tx.meta && tx.meta.preBalances && tx.meta.postBalances) {
        const preBalances = tx.meta.preBalances;
        const postBalances = tx.meta.postBalances;

        for (let i = 0; i < preBalances.length; i++) {
            const solSpent = (preBalances[i] - postBalances[i]) / 1e9;
            if (solSpent > 0) {
                totalSolSpent += solSpent;
            }
        }
    }

    return totalSolSpent;
}
// Глобальный Set для отслеживания обработанных транзакций
const processedSignatures = new Set();

function subscribeToWallet(address) {
    const publicKey = new PublicKey(address);

    const subscriptionId = connection.onLogs(publicKey, async (logInfo) => {
        const signature = logInfo.signature;

        // Проверяем, обработана ли эта транзакция ранее
        if (processedSignatures.has(signature)) {
            console.log(`Transaction ${signature} already processed. Skipping.`);
            return;
        }

        try {
            const tx = await addToQueue(() =>
                connection.getTransaction(signature, {
                    maxSupportedTransactionVersion: 0,
                })
            );

            if (!tx || !tx.meta) {
                console.warn(`Transaction ${signature} does not contain metadata.`);
                return;
            }

            if (!Array.isArray(tx.meta.postTokenBalances)) {
                console.warn(`Transaction ${signature} does not contain token balances.`);
                return;
            }

            const uniqueMints = new Set(); // Для уникальности токенов
            const tokenTransfers = tx.meta.postTokenBalances.filter((balance, index) => {
                const preBalance =
                    tx.meta.preTokenBalances?.[index]?.uiTokenAmount?.amount || 0;
                const postBalance =
                    tx.meta.postTokenBalances?.[index]?.uiTokenAmount?.amount || 0;

                const isUniqueMint =
                    balance.mint &&
                    balance.mint !== "So11111111111111111111111111111111111111112" &&
                    balance.mint !== "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" &&
                    balance.mint !== "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" &&
                    !uniqueMints.has(balance.mint);

                if (isUniqueMint) {
                    uniqueMints.add(balance.mint);
                }

                return (
                    Number(preBalance) < Number(postBalance) && // Баланс вырос
                    isUniqueMint
                );
            });

            if (tokenTransfers.length === 0) {
                console.log(`Transaction ${signature} is not related to tracked tokens.`);
                return;
            }

            for (const transfer of tokenTransfers) {
                const tokenMint = transfer.mint;
                const amountInSol = await calculateSolSpent(tx);

                const message = `
🐳 **Transaction detected for wallet ${address}:**
🔗 [View on Solscan](https://solscan.io/tx/${signature})
💸 **SOL:** ${amountInSol} SOL
🎯 **Token:** ${tokenMint}
📷 [Параметры](https://cdn.dexscreener.com/token-images/og/solana/${tokenMint}?timestamp=${Date.now()})
📊 Dexscreener: [Open on Dexscreener](https://dexscreener.com/solana/${tokenMint})
`;

                // Send message to all users
                users.forEach((userId) =>
                    bot.sendMessage(userId, message, { parse_mode: 'Markdown' })
                );
            }

            // Добавляем обработанную транзакцию в Set
            processedSignatures.add(signature);
        } catch (error) {
            console.error(
                `Error processing transaction ${signature} for wallet ${address}:`,
                error.message
            );
        }
    }, 'confirmed');

    subscriptions.set(address, subscriptionId);
    console.log(`Subscribed to wallet: ${address}`);
}


// Unsubscribe from a wallet
function unsubscribeFromWallet(address) {
    if (subscriptions.has(address)) {
        const subscriptionId = subscriptions.get(address);
        connection.removeOnLogsListener(subscriptionId);
        subscriptions.delete(address);
        console.log(`Unsubscribed from wallet: ${address}`);
    } else {
        console.log(`No active subscription for wallet: ${address}`);
    }
}

// Subscribe to all wallets on startup
function subscribeToAllWallets() {
    whales.forEach(wallet => subscribeToWallet(wallet));
}

// Commands
bot.onText(/\/hookwhale/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 'Send me the whale wallet address to track.').then(() => {
        bot.once('message', (msg) => {
            const wallet = msg.text.trim();
            if (wallet && !whales.includes(wallet)) {
                whales.push(wallet);
                saveWhalesToFile();
                subscribeToWallet(wallet);
                bot.sendMessage(chatId, `Whale wallet ${wallet} is now being tracked.`);
            } else {
                bot.sendMessage(chatId, `Wallet ${wallet} is already being tracked or invalid.`);
            }
        });
    });
});

bot.onText(/\/releasewhale/, (msg) => {
    const chatId = msg.chat.id;
    if (whales.length === 0) {
        bot.sendMessage(chatId, 'No wallets are currently being tracked.');
        return;
    }
    bot.sendMessage(chatId, 'Send me the whale wallet address to stop tracking.').then(() => {
        bot.once('message', (msg) => {
            const wallet = msg.text.trim();
            const index = whales.indexOf(wallet);
            if (index !== -1) {
                whales.splice(index, 1);
                saveWhalesToFile();
                unsubscribeFromWallet(wallet);
                bot.sendMessage(chatId, `Whale wallet ${wallet} has been removed.`);
            } else {
                bot.sendMessage(chatId, `Wallet ${wallet} is not being tracked.`);
            }
        });
    });
});

bot.onText(/\/listwhales/, (msg) => {
    const chatId = msg.chat.id;
    if (whales.length === 0) {
        bot.sendMessage(chatId, 'No wallets are currently being tracked.');
    } else {
        const whaleList = whales.map((wallet, index) => `${index + 1}. ${wallet}`).join('\n');
        bot.sendMessage(chatId, `Tracked whale wallets:\n\n${whaleList}`);
    }
});

// Start subscriptions
subscribeToAllWallets();
console.log('Bot is running and subscribed to all tracked wallets.');
