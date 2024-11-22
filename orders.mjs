import {
    Connection,
    Keypair,
    Transaction,
    VersionedTransaction,
    sendAndConfirmTransaction,
    PublicKey
  } from "@solana/web3.js";
  import axios from "axios";
  import bs58 from "bs58";
  // Параметры
    const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
    const PURCHASE_AMOUNT_SOL = 0.005; // Сумма покупки в SOL
    const TARGET_MULTIPLIER = 1.9; // Множитель для продажи токена
    const CHECK_INTERVAL = 5000; // Интервал проверки цены (в миллисекундах)
    const SOLADRESS = "So11111111111111111111111111111111111111112"
    // Ваш приватный ключ в формате Base58
    const PRIVATE_KEY_BASE58 = "5tfBhabwJpPhSvsRDJwtSjGh278FgSLhKuYDM7iWKckLoGcF3c8F7RV4kBS7Zb68p8s5rsNmrTsuhJfSxWvQcdqT";

    // Преобразуем приватный ключ из Base58 в Uint8Array
    const secretKey = Uint8Array.from(bs58.decode(PRIVATE_KEY_BASE58));
    const wallet = Keypair.fromSecretKey(secretKey);
    console.log(`Wallet loaded: ${wallet.publicKey.toBase58()}`);

    // Подключение к Solana
    const connection = new Connection(RPC_ENDPOINT, 'confirmed');
    // Получение пула ликвидности для токена
    async function getLiquidityPools(tokenMint) {
        
    
        try {
            // Получение всех счетов, связанных с Raydium AMM
            const accounts = await connection.getProgramAccounts(new PublicKey("RVKd61ztZW9ipAdUCeRUc9J6HuAmDQdj4CaHkG3iSAW"));
    
            console.log(`Найдено ${accounts.length} аккаунтов для программы Raydium AMM.`);
    
            const matchingPools = [];
    
            for (const account of accounts) {
                const data = account.account.data;
    
                // Парсинг данных пула (определите формат для Raydium)
                const pool = parsePoolData(data);
                if (!pool) continue;
    
                // Проверяем, связан ли пул с заданным токеном
                if (pool.mintA === tokenMint || pool.mintB === tokenMint) {
                    matchingPools.push(pool);
                }
            }
    
            if (matchingPools.length === 0) {
                console.log(`Пул ликвидности для токена ${tokenMint} не найден.`);
                return null;
            }
    
            console.log(`Найдено ${matchingPools.length} пул(ов) для токена ${tokenMint}.`, matchingPools);
            return matchingPools;
        } catch (error) {
            console.error(`Ошибка при получении данных пула: ${error.message}`);
            return null;
        }
    }
    
    function parsePoolData(data) {
        try {
            // Определите и реализуйте формат данных пула Raydium
            const mintA = data.slice(0, 32); // Первый токен пула (пример)
            const mintB = data.slice(32, 64); // Второй токен пула (пример)
    
            return {
                mintA: new PublicKey(mintA).toString(),
                mintB: new PublicKey(mintB).toString(),
            };
        } catch (error) {
            console.error('Ошибка парсинга данных пула:', error.message);
            return null;
        }
    }
    

// Рассчитываем цену токена в SOL
async function calculateTokenPriceInSol(tokenMint) {
    const pool = await getLiquidityPools(tokenMint)
console.log(pool)
    if (!pool) {
        console.error(`Не удалось найти пул для токена ${tokenMint}`);
        return null;
    }

    // Определяем токен и SOL в пуле
    const isTokenMintA = pool.mintA === tokenMint;
    const tokenReserve = isTokenMintA ? pool.reserveA : pool.reserveB;
    const solReserve = isTokenMintA ? pool.reserveB : pool.reserveA;

    // Рассчитываем цену токена в SOL
    const priceInSol = solReserve / tokenReserve;

    console.log(`Цена токена ${tokenMint} в SOL: ${priceInSol}`);
    return priceInSol;
}
  async function performSwap(to, from, amount) {
  
    // Swap parameters
    const params = new URLSearchParams({
      from: from, // SOL
      to: to, // USDC
      amount: amount, // From amount
      slip: 5, // Slippage
      fee: 0.002,
      payer: wallet.publicKey.toBase58()
    });
  
    try {
      // Get swap transaction
      const response = await axios.get(
        `https://swap.solxtence.com/swap?${params}`
      );
      console.log("RESPONSE: ",  response.data)
      const { serializedTx, txType } = response.data.transaction;
      
      // Fetch the latest blockhash
      const { blockhash } = await connection.getLatestBlockhash();
      
      // Deserialize and sign the transaction
      let transaction;
      if (txType === "v0") {
        transaction = VersionedTransaction.deserialize(
          Buffer.from(serializedTx, "base64")
        );
        transaction.message.recentBlockhash = blockhash;
        transaction.sign([wallet]);
        const signature = await sendAndConfirmTransaction(connection, transaction);
        console.log("Swap successful! Transaction signature:", signature);
      } else {
        transaction = Transaction.from(Buffer.from(serializedTx, "base64"));
        transaction.recentBlockhash = blockhash;
        transaction.sign(wallet);
        const signature = await sendAndConfirmTransaction(connection, transaction, [wallet]);
        console.log("Swap successful! Transaction signature:", signature);
      }
  
      console.log("2 ", transaction)
      // Send and confirm the transaction
      
      
      
      return response.data
    } catch (error) {
      console.error("Error performing swap:", error);
      return null
    }
  }
// Получение токенов из логов транзакции
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
var t = 0;
// Основной процесс: работа с логами
(async () => {
    connection.onLogs(new PublicKey('7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5'), async (logInfo) => {
        try {
            const signature = logInfo.signature;
                const tx = await connection.getTransaction(signature, {
                    maxSupportedTransactionVersion: 0,
                });
    
                const tokenAddress = getMostFrequentToken(tx);
                if (!tokenAddress) {
                    console.log("Токен не найден в логах. Пропускаем.");
                    return;
                }
    
                console.log('Новый токен обнаружен:', tokenAddress);
            return
           
            // setTimeout(async () => {
                // const signature = logInfo.signature;
                // const tx = await connection.getTransaction(signature, {
                //     maxSupportedTransactionVersion: 0,
                // });
    
                // const tokenAddress = getMostFrequentToken(tx);
                // if (!tokenAddress) {
                //     console.log("Токен не найден в логах. Пропускаем.");
                //     return;
                // }
    
                console.log('Новый токен обнаружен:', tokenAddress);
    
                const sign = await performSwap(tokenAddress, SOLADRESS, PURCHASE_AMOUNT_SOL)
                if (!sign) {
                    console.error(`Не удалось купить токен ${tokenAddress}.`);
                    return;
                }
    t++
                console.log(`Ожидаем роста цены для токена ${tokenAddress}...`);
                const targetPrice = sign.swapDetails.priceData.spotPrice * TARGET_MULTIPLIER;
    
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
    
                        const sellSuccess = await performSwap(SOLADRESS, tokenAddress, sign.swapDetails.outputAmount)
                        if (sellSuccess) {
                            console.log(`Токен ${tokenAddress} успешно продан.`);
                        } else {
                            console.error(`Не удалось продать токен ${tokenAddress}.`);
                        }
                    }
                }, CHECK_INTERVAL);
            // }, 10000)
            
        } catch (error) {
            console.error('Ошибка:', error.message);
        }
    });
})();

