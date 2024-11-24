import {
    Connection,
    Keypair,
    Transaction,
    sendAndConfirmTransaction,
    PublicKey,
} from "@solana/web3.js";
import axios from "axios";
import bs58 from "bs58";
import { API_URLS } from '@raydium-io/raydium-sdk-v2'
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';

// Параметры
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const PURCHASE_AMOUNT_SOL = 0.0005; // Сумма покупки в SOL
const TARGET_MULTIPLIER = 1.9; // Множитель для продажи токена
const CHECK_INTERVAL = 5000; // Интервал проверки цены (в миллисекундах)
const SOL_ADDRESS = "So11111111111111111111111111111111111111112";
const feeInSol = 0.0002
// Ваш приватный ключ в формате Base58
const PRIVATE_KEY_BASE58 = "3dXJcptxetMHPn8gsDr8KWTioQT1jJTA4gvK7ccpZU1LFXDKdHAVvHMzQKWNKHbhQEnqBKLQq3QrgqsJ7bMeHtGC";

// Преобразуем приватный ключ из Base58 в Uint8Array
const secretKey = Uint8Array.from(bs58.decode(PRIVATE_KEY_BASE58));
const wallet = Keypair.fromSecretKey(secretKey);
console.log(`Wallet loaded: ${wallet.publicKey.toBase58()}`);

// Подключение к Solana
const connection = new Connection(RPC_ENDPOINT, 'confirmed');

// Получение котировки свопа
async function getQuote(inputMint, outputMint, amount, slippage, txVersion) {
    try {
        
      const response = await axios.get(
        `${API_URLS.SWAP_HOST}/compute/swap-base-in`,
        {
          params: {
            inputMint,
            outputMint,
            amount,
            slippageBps: slippage * 100,
            txVersion
          }
        }
      );
  
      if (response.status !== 200 || !response.data) {
        console.error('Ошибка получения данных котировки.', response.data);
        return null;
      }
  
      return response.data;
    } catch (error) {
      console.error('Ошибка получения котировки:', error.message);
      return null;
    }
  }
async function performSwap(toMint, fromMint, amountInSol) {
    try {
        const amountInLamports = Math.floor(amountInSol * 1_000_000_000); // SOL → лампорты
        const computeUnitPriceMicroLamports = Math.floor(feeInSol * 1_000_000_000); // SOL → микролампорты
        const isInputSol = fromMint === SOL_ADDRESS;
        const isOutputSol = toMint === SOL_ADDRESS;

        console.log(`Параметры свопа:`);
        console.log(`От: ${fromMint}, К: ${toMint}, Сумма: ${amountInLamports} лампортов`);
        console.log(`Приоритетная комиссия: ${computeUnitPriceMicroLamports} микролампорты (${feeInSol} SOL)`);

        // Получение котировки
        const swapResponse = await getQuote(fromMint, toMint, amountInLamports, 0.05, 'V1');
        if (!swapResponse) {
            console.error('Не удалось получить данные свопа.');
            return null;
        }

        // Получение транзакций
        const { data: swapTransactions } = await axios.post(
            `${API_URLS.SWAP_HOST}/transaction/swap-base-in`,
            {
                computeUnitPriceMicroLamports: String(computeUnitPriceMicroLamports), // Комиссия в микролампортах
                swapResponse,
                txVersion: "V0", // Использование версии транзакций
                wallet: wallet.publicKey.toBase58(),
                wrapSol: isInputSol,
                unwrapSol: isOutputSol,
                // inputAccount: isInputSol ? undefined : await getOrCreateAssociatedTokenAccount(fromMint),
                // outputAccount: isOutputSol ? undefined : await getOrCreateAssociatedTokenAccount(toMint),
            }
        );

        if (!swapTransactions.success) {
            console.error("Ошибка выполнения свопа через Raydium.", swapTransactions);
            return null;
        }

        // Десериализация и отправка транзакций
        for (const tx of swapTransactions.data) {
            const transaction = Transaction.from(Buffer.from(tx.transaction, "base64"));
            transaction.sign(wallet);
            const signature = await sendAndConfirmTransaction(connection, transaction, [wallet]);
            console.log("Своп успешен! Подпись транзакции:", signature);
        }

        return swapResponse;
    } catch (error) {
        console.error("Ошибка выполнения свопа:", error.message);
        return null;
    }
}
function getMostFrequentToken(transactionData) {
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

    const filteredTokens = tokenAddresses.filter((item) => item !== SOL_ADDRESS);

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

async function getOrCreateAssociatedTokenAccount(mint) {
    try {
        const associatedTokenAddress = await getAssociatedTokenAddress(
            new PublicKey(mint), // Mint токена
            wallet.publicKey // Кошелек пользователя
        );

        // Проверяем, существует ли токен-аккаунт
        const accountInfo = await connection.getAccountInfo(associatedTokenAddress);
        if (!accountInfo) {
            console.log(`Токен-аккаунт для ${mint} не найден. Создаем новый.`);

            // Создаем транзакцию для создания токен-аккаунта
            const transaction = new Transaction().add(
                createAssociatedTokenAccountInstruction(
                    wallet.publicKey, // Плательщик
                    associatedTokenAddress, // Новый токен-аккаунт
                    wallet.publicKey, // Владелец
                    new PublicKey(mint) // Mint токена
                )
            );

            // Подписываем и отправляем транзакцию
            await sendAndConfirmTransaction(connection, transaction, [wallet]);
            console.log(`Токен-аккаунт создан: ${associatedTokenAddress.toBase58()}`);
        } else {
            console.log(`Токен-аккаунт уже существует: ${associatedTokenAddress.toBase58()}`);
        }

        return associatedTokenAddress.toBase58();
    } catch (error) {
        console.error('Ошибка при создании токен-аккаунта:', error.message);
        return null;
    }
}

// Основной процесс: работа с логами
(async () => {
    connection.onLogs(new PublicKey('7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5'), async (logInfo) => {
        try {
            setTimeout(async () => {
                const signature = logInfo.signature;
                const tx = await connection.getTransaction(signature, {
                    maxSupportedTransactionVersion: 0,
                });

                const tokenAddress = getMostFrequentToken(tx);
                if (!tokenAddress) {
                    console.log("Токен не найден в логах. Пропускаем.");
                    return;
                }

                console.log("Новый токен обнаружен:", tokenAddress);

                const swapResult = await performSwap(tokenAddress, SOL_ADDRESS, PURCHASE_AMOUNT_SOL);
                if (!swapResult) {
                    console.error(`Не удалось купить токен ${tokenAddress}.`);
                    return;
                }

                console.log(`Ожидаем роста цены для токена ${tokenAddress}...`);
                const targetPrice = swapResult.swapDetails.priceData.spotPrice * TARGET_MULTIPLIER;

                // Ожидание роста цены и продажа
                const intervalId = setInterval(async () => {
                    const currentPrice = await calculateTokenPriceInSol(tokenAddress);
                    if (!currentPrice) {
                        console.error(`Ошибка получения текущей цены для ${tokenAddress}.`);
                        return;
                    }

                    console.log(`Текущая цена для ${tokenAddress}: ${currentPrice}`);
                    if (currentPrice >= targetPrice) {
                        clearInterval(intervalId);
                        console.log(`Целевая цена достигнута (${currentPrice}). Продаём токен.`);

                        const sellSuccess = await performSwap(SOL_ADDRESS, tokenAddress, swapResult.swapDetails.outputAmount);
                        if (sellSuccess) {
                            console.log(`Токен ${tokenAddress} успешно продан.`);
                        } else {
                            console.error(`Не удалось продать токен ${tokenAddress}.`);
                        }
                    }
                }, CHECK_INTERVAL);
            }, 40000);
        } catch (error) {
            console.error("Ошибка:", error.message);
        }
    });
})();
