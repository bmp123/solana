const axios = require('axios');
const fs = require('fs');

const TOKENS_PATH = './tokens.json'; // Файл для сохранения всех токенов
const ANNOUNCED_PAIRS_PATH = './announced_pairs.json'; // Файл для сохранения пар из анонсов
const COINBASE_PATH = './coinbase_tokens.json';
const UPBIT_PATH = './upbit_tokens.json';
const ROBINHOOD_PATH = './robinhood_tokens.json';

const TELEGRAM_BOT_TOKEN = '7598035078:AAE5XXbnGKFWdz6nuk--P74TSd1iWg5zce8';
const TELEGRAM_CHAT_IDS = ['280101728', '170788417'];

// Функция задержки
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Общая функция для сохранения данных в файл
function saveToFile(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`Данные сохранены в файл: ${filePath}`);
}

// Общая функция для загрузки данных из файла
function loadFromFile(filePath) {
    if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath);
        return JSON.parse(data);
    }
    return [];
}

// Отправка сообщения в Telegram
async function sendTelegramMessage(message) {
    for (const chatId of TELEGRAM_CHAT_IDS) {
        try {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown'
            });
            console.log(`Сообщение отправлено в чат ${chatId}`);
        } catch (error) {
            console.error(`Ошибка отправки сообщения в чат ${chatId}:`, error.message);
        }
    }
}

// Получение текущего списка токенов с Binance
async function fetchTokens() {
    try {
        const response = await axios.get('https://api.binance.com/api/v3/exchangeInfo');
        const symbols = response.data.symbols;

        const tokens = new Set();
        symbols.forEach(pair => {
            tokens.add(pair.baseAsset);
            tokens.add(pair.quoteAsset);
        });

        return Array.from(tokens);
    } catch (error) {
        console.error('Ошибка при получении списка токенов Binance:', error.message);
        return [];
    }
}

// Получение токенов с Coinbase
async function fetchCoinbaseTokens() {
    try {
        const response = await axios.get('https://api.exchange.coinbase.com/products');
        const products = response.data;

        const tokens = new Set();
        products.forEach(product => {
            tokens.add(product.base_currency);
            tokens.add(product.quote_currency);
        });

        return Array.from(tokens);
    } catch (error) {
        console.error('Ошибка при получении списка токенов Coinbase:', error.message);
        return [];
    }
}

// Получение токенов с Upbit
async function fetchUpbitTokens() {
    try {
        const response = await axios.get('https://api.upbit.com/v1/market/all');
        const markets = response.data;

        const tokens = new Set();
        markets.forEach(market => {
            const [marketType, token] = market.market.split('-');
            tokens.add(token);
        });

        return Array.from(tokens);
    } catch (error) {
        console.error('Ошибка при получении списка токенов Upbit:', error.message);
        return [];
    }
}

// Получение токенов с Robinhood
async function fetchRobinhoodTokens() {
    try {
        const response = await axios.get('https://robinhood.com/api/instruments'); // Замените на актуальный URL, если он доступен
        const instruments = response.data.results;

        const tokens = instruments.map(instrument => instrument.symbol);

        return tokens;
    } catch (error) {
        console.error('Ошибка при получении списка токенов Robinhood:', error.message);
        return [];
    }
}

// Проверка новых токенов Binance
async function checkForNewTokens() {
    const savedTokens = loadFromFile(TOKENS_PATH);
    const currentTokens = await fetchTokens();

    const newTokens = currentTokens.filter(token => !savedTokens.includes(token));
    if (newTokens.length > 0) {
        console.log('Найдены новые токены Binance:', newTokens);
        saveToFile(TOKENS_PATH, [...savedTokens, ...currentTokens]);

        for (const token of newTokens) {
            const message = `🔔 Найден новый токен на Binance: *${token}*\n[Посмотреть на Binance](https://www.binance.com/en/trade/${token}_USDT)`;
            await sendTelegramMessage(message);
        }
    } else {
        console.log('Новых токенов Binance не обнаружено.');
    }
}

// Проверка новых токенов Coinbase
async function checkForNewCoinbaseTokens() {
    const savedTokens = loadFromFile(COINBASE_PATH);
    const currentTokens = await fetchCoinbaseTokens();

    const newTokens = currentTokens.filter(token => !savedTokens.includes(token));
    if (newTokens.length > 0) {
        console.log('Найдены новые токены Coinbase:', newTokens);
        saveToFile(COINBASE_PATH, [...savedTokens, ...currentTokens]);

        for (const token of newTokens) {
            const message = `🔔 Найден новый токен на Coinbase: *${token}*\n[Посмотреть на Coinbase](https://www.coinbase.com/price/${token.toLowerCase()})`;
            await sendTelegramMessage(message);
        }
    } else {
        console.log('Новых токенов Coinbase не обнаружено.');
    }
}

// Проверка новых токенов Upbit
async function checkForNewUpbitTokens() {
    const savedTokens = loadFromFile(UPBIT_PATH);
    const currentTokens = await fetchUpbitTokens();

    const newTokens = currentTokens.filter(token => !savedTokens.includes(token));
    if (newTokens.length > 0) {
        console.log('Найдены новые токены Upbit:', newTokens);
        saveToFile(UPBIT_PATH, [...savedTokens, ...currentTokens]);

        for (const token of newTokens) {
            const message = `🔔 Найден новый токен на Upbit: *${token}*\n[Посмотреть на Upbit](https://upbit.com/exchange?code=CRIX.UPBIT.${token})`;
            await sendTelegramMessage(message);
        }
    } else {
        console.log('Новых токенов Upbit не обнаружено.');
    }
}

// Проверка новых токенов Robinhood
async function checkForNewRobinhoodTokens() {
    const savedTokens = loadFromFile(ROBINHOOD_PATH);
    const currentTokens = await fetchRobinhoodTokens();

    const newTokens = currentTokens.filter(token => !savedTokens.includes(token));
    if (newTokens.length > 0) {
        console.log('Найдены новые токены Robinhood:', newTokens);
        saveToFile(ROBINHOOD_PATH, [...savedTokens, ...currentTokens]);

        for (const token of newTokens) {
            const message = `🔔 Найден новый токен на Robinhood: *${token}*\n[Посмотреть на Robinhood](https://robinhood.com/us/en/support)`;
            await sendTelegramMessage(message);
        }
    } else {
        console.log('Новых токенов Robinhood не обнаружено.');
    }
}

// Запуск мониторинга
(async () => {
    console.log('Запуск мониторинга новых токенов...');

    await checkForNewTokens();
    await checkForNewCoinbaseTokens();
    await checkForNewUpbitTokens();
    // await checkForNewRobinhoodTokens();

    // Интервалы для каждого мониторинга
    setInterval(checkForNewTokens, 1000); // Binance - каждые 10 минут
    setInterval(checkForNewCoinbaseTokens, 1000); // Coinbase - каждые 15 минут
    setInterval(checkForNewUpbitTokens, 1000); // Upbit - каждые 10 минут
    // setInterval(checkForNewRobinhoodTokens, 1000); // Robinhood - каждые 20 минут
})();