import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import { execFile } from 'child_process';
import { resolve } from 'path';
import { appendFile } from 'fs';

// Путь к файлу для хранения адресов токенов
// const ERROR_LOG_FILE = resolve(__dirname, 'error_logs.txt');

function logErrorToFile(tokenAddress, reason, errorDetails) {
    // const logEntry = `[${new Date().toISOString()}] Token: ${tokenAddress || 'Unknown'}, Reason: ${reason}, Details: ${errorDetails}\n`;
    // appendFile(ERROR_LOG_FILE, logEntry, (err) => {
    //     if (err) console.error('Ошибка записи логов в файл:', err.message);
    // });
}

// Создаем экземпляр бота с использованием Long Polling

// Конфигурация
const RPC_SERVERS = [
    'https://summer-quaint-dream.solana-mainnet.quiknode.pro/9898a29e57e62e92e6e06f89d40c6e7c85d19121',
    'https://api.mainnet-beta.solana.com'
];
let currentRpcIndex = 0;
let connection = new Connection(RPC_SERVERS[1], {
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
});
let connectionForToken = new Connection(RPC_SERVERS[1], {
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
});
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const WHALE_THRESHOLD = 1; // Минимальная сумма в USD для транзакции "кита"
const UPDATE_INTERVAL = 10000; // Интервал обновления списка токенов
const TELEGRAM_BOT_TOKEN = '7136076038:AAHLDvdWqtWusOrF3cd1BWaFeWWhOcRGrl8';
const TELEGRAM_SCAM_CONTRACTS = new Set(); // Глобальная переменная для хранения контрактов токенов
const TELEGRAM_CHAT_IDS = ['280101728', '170788417'];
let trackedTokens = new Map();
const subscriptions = new Map();
// Глобальная очередь запросов
let requestQueue = [];
let isProcessingQueue = false;
const delay = 500;
const processedTransactions = new Set();
const MAX_PROCESSED_TRANSACTIONS = 1000;
const MAX_TRACKED_TOKENS = 5000;
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
function subscribeToTokenLogs(tokenAddress) {
    if (subscriptions.has(tokenAddress)) {
        console.log(`Уже подписаны на токен: ${tokenAddress}`);
        return;
    }

    const subscriptionId = connection.onLogs(
        new PublicKey(tokenAddress),
        async (logInfo) => {
            console.log(JSON.stringify(logInfo))
            return
            
        }
    );

    subscriptions.set(tokenAddress, subscriptionId);
    console.log(`Подписка на логи токена ${tokenAddress} создана.`);
}
async function processTokens(tokens, needNotify = false) {
    for (const token of tokens) {
        const tokenAddress = token.tokenAddress;
        if (trackedTokens.has(tokenAddress)) {
            continue;
        }

        try {
            const tokenDetails = await getTokenDetails(tokenAddress);
            if (!tokenDetails) {
                logErrorToFile(tokenAddress, 'Детали токена не найдены', 'Skipped processing due to missing details');
                continue;
            }

            const { marketCap, volume, info } = tokenDetails;
            if (marketCap < 70000 || marketCap > 50000000 || volume.h24 < 50000 || tokenDetails.liquidity.usd <= 500) {
                logErrorToFile(tokenAddress, 'Токен не соответствует условиям', JSON.stringify(tokenDetails));
                continue;
            }

            trackedTokens.set(tokenAddress, {
                name: tokenDetails.baseToken.name,
                contract: tokenAddress,
                marketCap,
            });
            await notifyTelegram(`Новый токен бежим туда!`, {
                name: tokenDetails.baseToken.name,
                socials: tokenData.socials,
                contract: tokenAddress,
                openGraph: `https://cdn.dexscreener.com/token-images/og/solana/${tokenAddress}?timestamp=${Date.now()}`
            }, totalAmount, signature);

            subscribeToTokenLogs(tokenAddress);
        } catch (error) {
            logErrorToFile(tokenAddress, 'Ошибка обработки токена', error.message);
        }
    }
}
// Функция для отправки уведомления с кнопкой "Scam"
async function notifyTelegram(text, tokenData, amountInSol, signature) {
    const message = 
`🚨 ${text} 🚨
💰 Потрачено: ${amountInSol.toFixed(2)} SOL
🔤 Название: ${tokenData.name}
📷 [Параметры](${tokenData.openGraph})
🌐 Соцсети:
${tokenData.socials && tokenData.socials.map((social) => `- [${social.type}](${social.url})`).join('\n')}

🔗 Подробнее: [Просмотреть транзакцию](https://solscan.io/tx/${signature})
📊 Dexscreener: [Открыть на Dexscreener](https://dexscreener.com/solana/${tokenData.contract})`; // Добавляем ссылку на изображение в конце сообщения
    // Перебор массива чатов и отправка сообщения каждому
    for (const chatId of TELEGRAM_CHAT_IDS) {
        try {
            await bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "Scam", callback_data: `scam_${tokenData.contract}` }
                        ]
                    ]
                }
            });
            console.log(`Сообщение успешно отправлено в чат ${chatId}`);
        } catch (error) {
            console.error(`Ошибка отправки сообщения в чат ${chatId}:`, error.message);
        }
    }
}
function extractTokenAddresses(transactionData) {
    const tokenAddresses = [];
    if (!transactionData || !transactionData.meta) {
        console.warn("Метаданные транзакции отсутствуют или не загружены.");
        return null;
    }

    const preTokenBalances = transactionData.meta.preTokenBalances || [];
    const postTokenBalances = transactionData.meta.postTokenBalances || [];
    const allTokenBalances = [...preTokenBalances, ...postTokenBalances];

    for (const balance of allTokenBalances) {
        if (balance.mint) {
            tokenAddresses.push(balance.mint);
        }
    }

    // Убираем токены SOL и определяем, какой токен появился чаще всего
    const filteredTokens = tokenAddresses.filter(
        (item) => item !== SOLADRESS
    );

    const tokenFrequency = filteredTokens.reduce((acc, token) => {
        acc[token] = (acc[token] || 0) + 1;
        return acc;
    }, {});

    let mostFrequentToken = null;
    let maxFrequency = 0;

    for (const [token, frequency] of Object.entries(tokenFrequency)) {
        if (frequency > maxFrequency) {
            mostFrequentToken = token;
            maxFrequency = frequency;
        }
    }

    return mostFrequentToken;
}
// Мониторинг новых токенов
async function monitorTokens() {
    connectionForToken.onLogs(new PublicKey(
        '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5'
      ), async (logInfo) => {
        const signature = logInfo.signature;
        const tx = await connectionForToken.getTransaction(signature, { maxSupportedTransactionVersion: 0 })
        setTimeout(async () => {
            const adresses = extractTokenAddresses(tx)
            await processTokens(adresses.map(item => ({tokenAddress: item })))
        }, 60000)
    })
}
// Основная функция
async function main() {
    console.log('Запуск мониторинга новых токенов и транзакций китов...');
    monitorTokens();
}

main().catch((error) => {
    console.error('Ошибка выполнения скрипта:', error);
});