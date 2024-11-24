import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import { execFile } from 'child_process';
import { resolve } from 'path';
import { appendFile } from 'fs';

// Путь к файлу для хранения адресов токенов
// const ERROR_LOG_FILE = resolve(__dirname, 'error_logs.txt');


// Создаем экземпляр бота с использованием Long Polling

// Конфигурация
const RPC_SERVERS = [
    'https://summer-quaint-dream.solana-mainnet.quiknode.pro/9898a29e57e62e92e6e06f89d40c6e7c85d19121',
    'https://api.mainnet-beta.solana.com'
];
let currentRpcIndex = 0;
let connection = new Connection(RPC_SERVERS[0], {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
});
let connectionForToken = new Connection(RPC_SERVERS[1], {
    commitment: 'confirmed',
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
const SOL_ADDRESS = "So11111111111111111111111111111111111111112";
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
function subscribeToTokenLogs(tokenAddress) {
    if (subscriptions.has(tokenAddress)) {
        console.log(`Уже подписаны на токен: ${tokenAddress}`);
        return;
    }

    const subscriptionId = connection.onLogs(
        new PublicKey(tokenAddress),
        async (logInfo) => {
            // console.log(JSON.stringify(logInfo))
            return
            
        }
    );

    subscriptions.set(tokenAddress, subscriptionId);
    console.log(`Подписка на логи токена ${tokenAddress} создана.`);
}
const API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjcmVhdGVkQXQiOjE3MzE3NDQ0MTI5MDgsImVtYWlsIjoiaWRhbmlsb3YxNkBnbWFpbC5jb20iLCJhY3Rpb24iOiJ0b2tlbi1hcGkiLCJhcGlWZXJzaW9uIjoidjIiLCJpYXQiOjE3MzE3NDQ0MTJ9.915DpDz2k4xzw7MGQ2HO73HZNWm_UAc7W10xdkccZRQ';

async function processTokens(tokens, needNotify = false) {
    for (const token of tokens) {
        const tokenAddress = token.tokenAddress;
        if (trackedTokens.has(tokenAddress)) {
            continue;
        }

        try {
            // const tokenDetails = await getTokenDetails(tokenAddress);
            const dex = await getDEXTokenDetails(tokenAddress)
            console.log("DEX: ", dex)
            if (!dex) {
                
                const sol = await getTokenDetails(tokenAddress)
                if (sol.marketCap && sol.marketCap >= 50000 && sol.marketCap <= 1000000) {
                    await notifyNewTokenTelegram(`Новый токен c говносолскана!`, {
                        name: sol.name,
                        contract: tokenAddress,
                        marketCap: sol.marketCap,
                        volume: 'хз',
                        openGraph: `https://cdn.dexscreener.com/token-images/og/solana/${tokenAddress}?timestamp=${Date.now()}`
                    });
                    continue;
                }
                console.log(tokenAddress, 'Детали токена не найдены', 'Skipped processing due to missing details');
                continue;
            }

            const { marketCap, liquidity, baseToken: {name}, priceUsd, info: { socials } } = dex;
            if (marketCap < 50000 || marketCap > 1000000 || liquidity.usd < 20000 || liquidity.usd > 150000 || priceUsd <= 0 || !socials || socials.count == 0) {
                console.log(tokenAddress, 'Токен не соответствует условиям');
                continue;
            }

            trackedTokens.set(tokenAddress, {
                name,
                contract: tokenAddress,
                marketCap,
            });

            // if (needNotify) {
                await notifyNewTokenTelegram(`Новый токен обнаружен!`, {
                    name,
                    contract: tokenAddress,
                    marketCap,
                    volume: liquidity.usd,
                    socials,
                    openGraph: `https://cdn.dexscreener.com/token-images/og/solana/${tokenAddress}?timestamp=${Date.now()}`
                });
            // }
            // subscribeToTokenLogs(tokenAddress);
        } catch (error) {
            console.log(tokenAddress, 'Ошибка обработки токена', error.message);
        }
    }
}
async function getDEXTokenDetails(tokenAddress) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
        if (response.data && response.data.pairs && response.data.pairs.length > 0) {
            return response.data.pairs[0];
        }
        const reason = `Не удалось получить данные для токена ${tokenAddress}`;
        console.log(tokenAddress, reason, 'No data returned or malformed response');
        return null;
    } catch (error) {
        const reason = `Ошибка при запросе данных для токена ${tokenAddress}`;
        console.log(tokenAddress, reason, error.message);
        return null;
    }
}
async function getTokenDetails(tokenAddress) {
    try {
        const response = await axios.get(
            `https://pro-api.solscan.io/v2.0/token/meta?address=${tokenAddress}`,
            {
                headers: {
                    'accept': 'application/json',
                    'token': API_KEY // Укажите ваш API-ключ
                }
            }
        );
        if (response.data && response.data.success) {
            const data = response.data.data;
            return {
                name: data.name, // Имя токена
                symbol: data.symbol, // Символ токена
                icon: data.icon, // Иконка токена
                decimals: data.decimals, // Десятичные знаки
                price: data.price, // Цена токена
                marketCap: data.market_cap, // Рыночная капитализация
                supply: data.supply, // Общее количество токенов
                holder: data.holder // Количество держателей
            };
        } else {
            const reason = `Не удалось получить данные для токена ${tokenAddress}`;
            console.log(tokenAddress, reason, 'No data returned or malformed response');
            return null;
        }
    } catch (error) {
        const reason = `Ошибка при запросе данных для токена ${tokenAddress}`;
        console.log(tokenAddress, reason, error.message);
        return null;
    }
}

async function notifyNewTokenTelegram(text, tokenData) {
    const message = 
`🚨 ${text} 🚨
💰 МаркетКап: ${tokenData.marketCap}
💰 Ликвидность: ${tokenData.volume}
🔤 Название: ${tokenData.name}
📷 [Параметры](${tokenData.openGraph})
🌐 Соцсети:
${tokenData.socials && tokenData.socials.map((social) => `- [${social.type}](${social.url})`).join('\n')}
📊 Dexscreener: [Открыть на Dexscreener](https://dexscreener.com/solana/${tokenData.contract})`; // Добавляем ссылку на изображение в конце сообщения

    // Перебор массива чатов и отправка сообщения каждому
    for (const chatId of TELEGRAM_CHAT_IDS) {
        try {
            await bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                // reply_markup: {
                //     inline_keyboard: [
                //         [
                //             { text: "Scam", callback_data: `scam_${tokenData.contract}` }
                //         ]
                //     ]
                // }
            });
            console.log(`Сообщение успешно отправлено в чат ${chatId}`);
        } catch (error) {
            console.error(`Ошибка отправки сообщения в чат ${chatId}:`, error.message);
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
        (item) => item !== SOL_ADDRESS
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
const taskQueue = [];
let isProcessing = false;

async function processQueue() {
    if (isProcessing || taskQueue.length === 0) return;
    isProcessing = true;

    while (taskQueue.length > 0) {
        const task = taskQueue.shift(); // Извлекаем первую задачу
        try {
            await task();
        } catch (error) {
            console.error('Ошибка при выполнении задачи:', error);
        }
        // Ждём 500 мс перед следующей задачей
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    isProcessing = false;
}
// Мониторинг новых токенов
async function monitorTokens() {
    connectionForToken.onLogs(new PublicKey(
        '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5'
      ), async (logInfo) => {
        try {
            setTimeout(() => {
                // Добавляем задачу в очередь через 60 секунд
                taskQueue.push(async () => {
                    const signature = logInfo.signature;
                    const tx = await connection.getTransaction(signature, {
                        maxSupportedTransactionVersion: 0,
                    });
                    const addresses = extractTokenAddresses(tx);
                    console.log('NEW TOKEN: ', addresses);
                    await processTokens([{ tokenAddress: addresses }]);
                });
                processQueue(); // Запускаем обработку очереди
            }, 50000); // Задержка в 60 секунд
        } catch (err) {
            console.error(err)
        }
        
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