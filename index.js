const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// Путь к файлу для хранения адресов токенов
const SCAM_TOKENS_FILE = path.resolve(__dirname, 'scam_tokens.json');
const ERROR_LOG_FILE = path.resolve(__dirname, 'error_logs.txt');

function logErrorToFile(tokenAddress, reason, errorDetails) {
    const logEntry = `[${new Date().toISOString()}] Token: ${tokenAddress || 'Unknown'}, Reason: ${reason}, Details: ${errorDetails}\n`;
    fs.appendFile(ERROR_LOG_FILE, logEntry, (err) => {
        if (err) console.error('Ошибка записи логов в файл:', err.message);
    });
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
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
// Смена RPC-сервера при ошибке
async function switchRpcServer() {
    currentRpcIndex = (currentRpcIndex + 1) % RPC_SERVERS.length;
    console.log(`Переключение на RPC-сервер: ${RPC_SERVERS[currentRpcIndex]}`);
    connection = new Connection(RPC_SERVERS[currentRpcIndex], {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
    });
    cleanupOldData(); // Очистка данных при переключении
}

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
    cleanupOldData();
}

function addToQueue(fn) {
    return new Promise((resolve, reject) => {
        requestQueue.push({ fn, resolve, reject });
        processQueue();
    });
}


// Очистка старых данных
function cleanupOldData() {
    while (processedTransactions.size > MAX_PROCESSED_TRANSACTIONS) {
        processedTransactions.delete(processedTransactions.keys().next().value);
    }

    if (trackedTokens.size > MAX_TRACKED_TOKENS) {
        const keys = Array.from(trackedTokens.keys());
        const keysToDelete = keys.slice(0, trackedTokens.size - MAX_TRACKED_TOKENS);
        keysToDelete.forEach((key) => trackedTokens.delete(key));
    }
}

const lastNotificationTimestamps = {};

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

function loadScamTokens() {
    try {
        if (fs.existsSync(SCAM_TOKENS_FILE)) {
            const data = fs.readFileSync(SCAM_TOKENS_FILE, 'utf8');
            const tokens = JSON.parse(data);
            tokens.forEach((token) => TELEGRAM_SCAM_CONTRACTS.add(token));
            console.log(`Загружено ${tokens.length} скам токенов из файла.`);
        } else {
            console.log("Файл с токенами не найден. Создано новое хранилище.");
        }
    } catch (error) {
        console.error("Ошибка загрузки токенов из файла:", error.message);
    }
}

// Добавление токена в файл (без перезаписи)
function appendScamTokenToFile(tokenContract) {
    try {
        let existingTokens = [];
        if (fs.existsSync(SCAM_TOKENS_FILE)) {
            const data = fs.readFileSync(SCAM_TOKENS_FILE, 'utf8');
            existingTokens = JSON.parse(data);
        }

        // Проверяем, есть ли уже токен в файле
        if (!existingTokens.includes(tokenContract)) {
            existingTokens.push(tokenContract);
            fs.writeFileSync(SCAM_TOKENS_FILE, JSON.stringify(existingTokens, null, 2), 'utf8');
            console.log(`Токен ${tokenContract} добавлен в файл.`);
        } else {
            console.log(`Токен ${tokenContract} уже существует в файле.`);
        }
    } catch (error) {
        console.error("Ошибка добавления токена в файл:", error.message);
    }
}

// Обработка нажатий кнопок
bot.on('callback_query', async (callbackQuery) => {
    const { data, message } = callbackQuery;

    if (data.startsWith('scam_')) {
        const tokenContract = data.replace('scam_', '');
        TELEGRAM_SCAM_CONTRACTS.add(tokenContract); // Добавляем контракт в глобальное хранилище
        console.log(`Токен ${tokenContract} добавлен в список скамов.`);

        // Записываем адрес токена в файл
        appendScamTokenToFile(tokenContract);

        unsubscribeFromTokenLogs(tokenContract);

        // Удаляем сообщение
        try {
            await bot.deleteMessage(message.chat.id, message.message_id);
            console.log(`Сообщение с кнопкой "Scam" удалено для токена ${tokenContract}.`);
        } catch (error) {
            console.error("Ошибка при удалении сообщения:", error.message);
        }
    }
});


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
// Функция подписки на логи для токена
const transactionCounters = new Map(); // Хранит счетчики транзакций для каждого токена

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
            const transferLogs = logInfo.logs.filter(log =>
                log.includes('Instruction: Transfer')
            );
            const isLocked = await checkForLock(`https://cdn.dexscreener.com/token-images/og/solana/${tokenAddress}?timestamp=${Date.now()}`)
            // console.log('LOCKED: ' + isLocked)
            if (!isLocked) {
                // console.log("Not Locked token ", tokenAddress)
                return
            }
            if (transferLogs.length > 0) {
                // Найти лог с информацией о сумме перевода
                const transferAmountLog = logInfo.logs.find(log =>
                    log.match(/amount_in:\s*(\d+)/) // Ищем сумму перевода
                );

                if (transferAmountLog) {
                    // Извлекаем сумму перевода
                    const amountMatch = transferAmountLog.match(/amount_in:\s*(\d+)/);
                    const amountInLamports = amountMatch ? parseInt(amountMatch[1], 10) : 0;

                    // Проверяем, превышает ли сумма 1 SOL
                    if (amountInLamports >= (WHALE_THRESHOLD * 1_000_000_000)) {
                        console.log('Успешный трансфер SOL на токен:', {
                            signature: logInfo.signature,
                            amount: amountInLamports,
                            tokenAddress,
                        });
                        const signature = logInfo.signature;
            
            try {
                // const tx = await connection.getTransaction(signature, {
                //     maxSupportedTransactionVersion: 0,
                // });

                // if (!tx || !tx.meta) {
                //     return;
                // }

                // Рассчитываем потраченные SOL
                // const amountInSol = await calculateSolSpent(tx);

                // if (amountInLamports >= WHALE_THRESHOLD) {
                    console.warn(`Обнаружена китовая транзакция для токена ${tokenAddress}: ${signature} на сумму: ${amountInLamports / 1_000_000_000}`);
                    
                    const tokenData = trackedTokens.get(tokenAddress);
                    if (tokenData) {
                        // Обновляем счетчик транзакций
                        updateTransactionCounter(tokenAddress, amountInLamports / 1_000_000_000);
                        
                        const counter = transactionCounters.get(tokenAddress);
                        const tokenDetails = await getTokenDetails(tokenAddress);
                        
                        const { marketCap, info, baseToken, volume } = tokenDetails;
            
                        if (
                            marketCap &&
                            marketCap >= 70000 &&
                            marketCap <= 50000000 &&
                            volume.h24 >= 50000 &&
                            tokenDetails.liquidity.usd > 500
                        ) {
                            
                            if (counter.count === 1) {
                                
                                
                                await notifyTelegram('Обнаружена китовая транзакция!', {
                                    name: tokenData.name,
                                    socials: tokenData.socials,
                                    contract: tokenAddress,
                                    openGraph: `https://cdn.dexscreener.com/token-images/og/solana/${tokenAddress}?timestamp=${Date.now()}`
                                }, amountInLamports / 1_000_000_000, signature);
                            }

                            if (counter.count >= 10) {
                                const totalAmount = counter.totalAmount; // Сумма всех транзакций
                                transactionCounters.delete(tokenAddress);
                                await notifyTelegram(`Пошла движуха по токену! Кол-во сделок: ${counter.count}`, {
                                    name: tokenData.name,
                                    socials: tokenData.socials,
                                    contract: tokenAddress,
                                    openGraph: `https://cdn.dexscreener.com/token-images/og/solana/${tokenAddress}?timestamp=${Date.now()}`
                                }, totalAmount, signature);

                                // Удаляем токен из отслеживаемых и отписываемся
                                unsubscribeFromTokenLogs(tokenAddress);
                                console.log(`Токен ${tokenAddress} удален из отслеживаемых.`);
                            }
                        } else {
                            logErrorToFile(tokenAddress, 'Транза не прошла условия', '');
                        }
                    }
                // }
            } catch (error) {
                console.error(`Ошибка обработки логов для токена ${tokenAddress}:`, error);
            }
                    }
                }
            }
            
            
        }
    );

    subscriptions.set(tokenAddress, subscriptionId);
    console.log(`Подписка на логи токена ${tokenAddress} создана.`);
}

// Функция обновления счетчика транзакций
function updateTransactionCounter(tokenAddress, amountInSol) {
    const currentTime = Date.now();

    if (!transactionCounters.has(tokenAddress)) {
        transactionCounters.set(tokenAddress, {
            count: 1,
            totalAmount: amountInSol, // Учитываем сумму первой транзакции
            firstTransactionTime: currentTime,
        });

        // Устанавливаем таймер на 5 минут для сброса счетчика
        setTimeout(() => {
            transactionCounters.delete(tokenAddress);
            console.log(`Счетчик для токена ${tokenAddress} сброшен.`);
        }, 5 * 60 * 1000); // 5 минут
    } else {
        const counter = transactionCounters.get(tokenAddress);
        counter.count += 1;
        counter.totalAmount += amountInSol; // Добавляем сумму новой транзакции
        transactionCounters.set(tokenAddress, counter);
    }
}

// Функция отписки от логов для токена
function unsubscribeFromTokenLogs(tokenAddress) {
    if (!subscriptions.has(tokenAddress)) {
        console.log(`Нет активной подписки для токена: ${tokenAddress}`);
        return;
    }

    const subscriptionId = subscriptions.get(tokenAddress);
    connection.removeOnLogsListener(subscriptionId);
    subscriptions.delete(tokenAddress);
    console.log(`Подписка на логи токена ${tokenAddress} удалена.`);
}

async function processTokens(tokens, needNotify = false) {
    for (const token of tokens) {
        const tokenAddress = token.tokenAddress;

        if (TELEGRAM_SCAM_CONTRACTS.has(tokenAddress)) {
            const reason = `Токен ${tokenAddress} помечен как скам`;
            logErrorToFile(tokenAddress, reason, 'Skipped due to scam marking');
            continue;
        }

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
async function checkForLock(templatePath) {
    return new Promise((resolve, reject) => {
        execFile(
            'python3',
            ['check_lock.py', templatePath, './lock_template.jpg'],
            (error, stdout, stderr) => {
                if (error) {
                    reject(`Ошибка выполнения Python-скрипта: ${stderr}`);
                } else {
                    try {
                        // console.log('Сырые данные из Python-скрипта:', stdout.trim()); // Логируем результат
                        const result = JSON.parse(stdout.trim());
                        resolve(result.found);
                    } catch (parseError) {
                        reject(`Ошибка парсинга результата: ${parseError.message}\nРезультат: ${stdout}`);
                    }
                }
            }
        );
    });
}
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

// Мониторинг новых токенов
async function monitorTokens() {
    console.log('Запуск мониторинга новых токенов...');
    // connectionForToken.onLogs(new PublicKey(
    //     '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5'
    //   ), async (logInfo) => {
    //     const signature = logInfo.signature;
    //     const tx = await connectionForToken.getTransaction(signature, {
    //             maxSupportedTransactionVersion: 0,
    //         })
    //     setTimeout(async () => {
    //         const adresses = extractTokenAddresses(tx)
    //         await processTokens(adresses.map(item => ({tokenAddress: item })))
    //     }, 50000)
    // })
    // setInterval(async () => {
    //     console.log('Обновляем данные о токенах...');
    //     // const tokens = await getTokensFromDexscreener();
    //     await processTokens(tokens);
    // }, UPDATE_INTERVAL);
}

async function getTokensFromDexscreener() {
    try {
        const response = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1');
        if (response.data && Array.isArray(response.data)) {
            console.log('Получены данные о новых токенах');
            return response.data.filter((token) => token.chainId === 'solana');
        }
        console.warn('Не удалось получить данные токенов');
        return [];
    } catch (error) {
        console.error('Ошибка при запросе данных токенов:', error);
        return [];
    }
}
// Функция для получения количества холдеров токена
async function getTokenHoldersCount(tokenAddress) {
    try {
        const tokenMint = new PublicKey(tokenAddress);

        // Получаем список крупнейших аккаунтов токена
        const largestAccounts = await connection.getTokenLargestAccounts(tokenMint);
        if (largestAccounts.value && largestAccounts.value.length > 0) {
            return largestAccounts.value.length; // Возвращаем количество холдеров
        }

        console.warn(`Не удалось получить держателей токена ${tokenAddress}`);
        return 0;
    } catch (error) {
        console.error(`Ошибка при получении держателей для токена ${tokenAddress}:`, error);
        return 0;
    }
}


async function getTokenDetails(tokenAddress) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
        if (response.data && response.data.pairs && response.data.pairs.length > 0) {
            return response.data.pairs[0];
        }
        const reason = `Не удалось получить данные для токена ${tokenAddress}`;
        logErrorToFile(tokenAddress, reason, 'No data returned or malformed response');
        return null;
    } catch (error) {
        const reason = `Ошибка при запросе данных для токена ${tokenAddress}`;
        logErrorToFile(tokenAddress, reason, error.message);
        return null;
    }
}

// Основная функция
async function main() {
    console.log('Запуск мониторинга новых токенов и транзакций китов...');
    loadScamTokens()
    monitorTokens();
}

main().catch((error) => {
    
    console.error('Ошибка выполнения скрипта:', error);
});