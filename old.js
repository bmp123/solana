const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

// Конфигурация
const RPC_SERVERS = [
    'https://rpc.ankr.com/solana',
    'https://solana-api.projectserum.com',
    'https://api.mainnet-beta.solana.com'
];
let currentRpcIndex = 0;
let connection = new Connection(RPC_SERVERS[currentRpcIndex], {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
});
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const WHALE_THRESHOLD = 0.2; // Минимальная сумма в USD для транзакции "кита"
const UPDATE_INTERVAL = 30000; // Интервал обновления списка токенов
const TELEGRAM_BOT_TOKEN = '7136076038:AAHLDvdWqtWusOrF3cd1BWaFeWWhOcRGrl8';
const TELEGRAM_CHAT_IDS = ['280101728', '170788417'];
let trackedTokens = new Map();

// Глобальная очередь запросов
let requestQueue = [];
let isProcessingQueue = false;
const delay = 500;
const processedTransactions = new Set();
const MAX_PROCESSED_TRANSACTIONS = 1000;
const MAX_TRACKED_TOKENS = 5000;

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

// Функция для отправки уведомлений в Telegram
async function notifyTelegram(tokenData, amountInSol, signature) {
    const currentTime = Date.now();
    const cooldownTime = 5 * 60 * 1000; // 5 минут в миллисекундах

    // Проверяем, было ли уже отправлено уведомление по этому токену
    if (lastNotificationTimestamps[tokenData.contract]) {
        const timeSinceLastNotification = currentTime - lastNotificationTimestamps[tokenData.contract];
        if (timeSinceLastNotification < cooldownTime) {
            console.log(`Оповещение по токену ${tokenData.contract} недавно отправлено. Ждем 5 минут.`);
            return;
        }
    }

    const message = `
🚨 Обнаружена китовая транзакция! 🚨
💰 Потрачено: ${amountInSol.toFixed(2)} SOL
📜 Контракт:
\`\`\`
${tokenData.contract}
\`\`\`
🔤 Название: ${tokenData.name}
💵 Капитализация: $${tokenData.marketCap.toLocaleString()}
👥 Холдеры: ${tokenData.holdersCount}
🌐 Соцсети:
${tokenData.socials.map((social) => `- [${social.type}](${social.url})`).join('\n')}

🔗 Подробнее: [Просмотреть транзакцию](https://solscan.io/tx/${signature})
📊 Dexscreener: [Открыть на Dexscreener](https://dexscreener.com/solana/${tokenData.contract})
    `;

    // Отправка уведомления в Telegram
    for (const chatId of TELEGRAM_CHAT_IDS) {
        try {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown',
            });
        } catch (error) {
            console.error(`Ошибка отправки уведомления в чат ${chatId}:`, error);
        }
    }

    // Обновляем время последней отправки уведомления для токена
    lastNotificationTimestamps[tokenData.contract] = currentTime;

    // Устанавливаем таймер для очистки записи
    setTimeout(() => {
        delete lastNotificationTimestamps[tokenData.contract];
        console.log(`Оповещение для токена ${tokenData.contract} снято с ожидания.`);
    }, cooldownTime);
}

function extractTokenAddresses(transactionData) {
    const tokenAddresses = [];

    // Проверяем, что transactionData и meta существуют
    if (!transactionData || !transactionData.meta) {
        // console.warn("Метаданные транзакции отсутствуют или не загружены.");
        return tokenAddresses; // Возвращаем пустой массив
    }

    // Проверяем preTokenBalances и postTokenBalances
    const preTokenBalances = transactionData.meta.preTokenBalances || [];
    const postTokenBalances = transactionData.meta.postTokenBalances || [];

    // Объединяем все балансы в один массив
    const allTokenBalances = [...preTokenBalances, ...postTokenBalances];

    for (const balance of allTokenBalances) {
        if (balance.mint) {
            tokenAddresses.push(balance.mint); // Добавляем адрес токена (mint)
        }
    }
    console.log(tokenAddresses)
    // Убираем дубликаты
    return [...new Set(tokenAddresses.filter(item => item !== 'So11111111111111111111111111111111111111112'))];
}


// Мониторинг транзакций китов
async function monitorWhaleTransactions() {
    console.log('Запуск мониторинга транзакций китов...');
    connection.onLogs(TOKEN_PROGRAM_ID, async (logInfo) => {
        const signature = logInfo.signature;
        
        try {
            // Проверяем, что логи содержат "Transfer" или "MintTo" и подтверждение
            const hasRelevantInstruction = logInfo.logs.some(log => 
                log.includes("Instruction: Transfer")
            );

            const isConfirmed = logInfo.logs.some(log => 
                log === `Program ${TOKEN_PROGRAM_ID} success`
            );

            if (!hasRelevantInstruction || !isConfirmed) {
                // Если не подтверждено или не содержит нужных инструкций, пропускаем
                // console.log(`Транзакция ${signature} не содержит "Transfer"  либо не подтверждена. Пропуск.`);
                return;
            }

            const tx = await addToQueue(() =>
                connection.getTransaction(signature, {
                    maxSupportedTransactionVersion: 0,
                })
            );

            if (tx && tx.meta && tx.meta.preBalances && tx.meta.postBalances) {
                const tokenTransfers = tx.meta.postTokenBalances.filter((balance, index) => {
                    const preBalance = tx.meta.preBalances[index] || 0;
                    const postBalance = tx.meta.postBalances[index] || 0;

                    return (
                        preBalance > postBalance &&
                        balance.mint &&
                        trackedTokens.has(balance.mint)
                    );
                });

                if (tokenTransfers.length === 0) {
                    // console.log(`Транзакция ${signature} не связана с контролируемыми токенами. Пропуск.`);
                    return;
                }

                for (const transfer of tokenTransfers) {
                    const tokenMint = transfer.mint;
                    

                    const amountInSol = await calculateSolSpent(tx);
                    console.log("alarm", amountInSol, tokenMint);
                    if (amountInSol >= WHALE_THRESHOLD) {
                        const tokenData = await getTokenDetails(tokenMint);
                        console.log(
                            `Обнаружена китовая транзакция: ${signature}, потрачено ${amountInSol} SOL на ${tokenData.baseToken.name} (${tokenMint})`
                        );
                        await notifyTelegram({
                            name: tokenData.baseToken.name,
                            contract: tokenMint,
                            marketCap: tokenData.marketCap,
                            holdersCount: trackedTokens.get(tokenMint).holdersCount,
                            socials: tokenData.info.socials,
                        }, amountInSol, signature);
                    }
                }
            }
        } catch (error) {
            console.error('Ошибка при обработке логов:', error);

            if (error.message.includes('Subscription refused')) {
                console.warn('Лимит подписок достигнут. Переключение на другой RPC-сервер.');
                await switchRpcServer();
            }
        }
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
    connection.onLogs(new PublicKey(
        '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5'
      ), async (logInfo) => {
        const signature = logInfo.signature;
        const tx = await connection.getTransaction(signature, {
                maxSupportedTransactionVersion: 0,
            })
        setTimeout(async () => {
            const adresses = extractTokenAddresses(tx)
            await processTokens(adresses.map(item => ({tokenAddress: item })))
        }, 10000)
    })
    setInterval(async () => {
        console.log('Обновляем данные о токенах...');
        const tokens = await getTokensFromDexscreener();
        await processTokens(tokens);
    }, UPDATE_INTERVAL);
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
async function processTokens(tokens) {
    for (const token of tokens) {
        // Проверяем, существует ли токен в trackedTokens
        if (trackedTokens.has(token.tokenAddress)) {
            console.log(`Токен уже существует: ${token.tokenAddress}. Пропуск.`);
            continue;
        }

        const tokenDetails = await getTokenDetails(token.tokenAddress);
        if (tokenDetails) {
            const { marketCap, info, baseToken } = tokenDetails;

            if (
                marketCap &&
                marketCap >= 100000 &&
                marketCap <= 1000000 &&
                info &&
                info.socials &&
                info.socials.length >= 2
            ) {
                const holdersCount = (await getTokenHoldersCount(token.tokenAddress)) || 0;

                // Сохраняем новый токен в trackedTokens
                trackedTokens.set(token.tokenAddress, {
                    name: baseToken.name,
                    contract: token.tokenAddress,
                    marketCap,
                    holdersCount,
                    socials: info.socials,
                });

                console.log(`Токен сохранен: ${baseToken.name} (${token.tokenAddress})`);
            } else {
                console.log(
                    `Токен ${baseToken?.name || 'Неизвестно'} (${token.tokenAddress}) не подходит по критериям`
                );
            }
        }
    }
}


async function getTokenDetails(tokenAddress) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
        if (response.data && response.data.pairs && response.data.pairs.length > 0) {
            return response.data.pairs[0];
        }
        console.warn(`Не удалось получить данные для токена ${tokenAddress} ${JSON.stringify(response.data)}`);
        return null;
    } catch (error) {
        console.error(`Ошибка при запросе данных для токена ${tokenAddress}:`, error);
        return null;
    }
}

// Основная функция
async function main() {
    console.log('Запуск мониторинга новых токенов и транзакций китов...');
    monitorTokens();
    monitorWhaleTransactions();
}

main().catch((error) => {
    console.error('Ошибка выполнения скрипта:', error);
});