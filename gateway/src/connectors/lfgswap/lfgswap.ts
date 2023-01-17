import { UniswapishPriceError } from '../../services/error-handler';
import { LfgswapConfig } from './lfgswap.config';
import routerAbi from './lfgswap_router.json';

import { ContractInterface } from '@ethersproject/contracts';

import {
  Percent,
  Router,
  Token,
  CurrencyAmount,
  Trade,
  Pair,
  SwapParameters,
  TradeType,
} from '@sushiswap/sdk';
import IUniswapV2Pair from '@uniswap/v2-core/build/IUniswapV2Pair.json';
import { ExpectedTrade, Uniswapish } from '../../services/common-interfaces';
import {
  BigNumber,
  Wallet,
  Transaction,
  Contract,
  ContractTransaction,
} from 'ethers';
import { percentRegexp } from '../../services/config-manager-v2';
import { logger } from '../../services/logger';
import { EthereumPow } from '../../chains/ethw/ethw';

export class Lfgswap implements Uniswapish {
  private static _instances: { [name: string]: Lfgswap };
  private chain: EthereumPow;
  private _router: string;
  private _routerAbi: ContractInterface;
  private _gasLimitEstimate: number;
  private _ttl: number;
  private chainId;
  private tokenList: Record<string, Token> = {};
  private _ready: boolean = false;

  private constructor(chain: string, network: string) {
    if (chain === 'ethw') {
      this.chain = EthereumPow.getInstance(network);
    } else if (chain === 'binance-smart-chain') {
      
    } else {
      throw new Error('unsupported chain');
    }
    const config = LfgswapConfig.config;
    this.chain = EthereumPow.getInstance(network);
    this.chainId = this.chain.chainId;
    this._ttl = config.ttl;
    this._routerAbi = routerAbi.abi;
    this._gasLimitEstimate = config.gasLimitEstimate;
    this._router = config.routerAddress(chain, network);
  }

  public static getInstance(chain: string, network: string): Lfgswap {
    if (Lfgswap._instances === undefined) {
      Lfgswap._instances = {};
    }
    if (!(chain + network in Lfgswap._instances)) {
      Lfgswap._instances[chain + network] = new Lfgswap(chain, network);
    }

    return Lfgswap._instances[chain + network];
  }

  /**
   * Given a token's address, return the connector's native representation of
   * the token.
   *
   * @param address Token address
   */
  public getTokenByAddress(address: string): Token {
    return this.tokenList[address];
  }

  public async init() {
    if (!this.chain.ready()) {
      await this.chain.init();
    }
    for (const token of this.chain.storedTokenList) {
      this.tokenList[token.address] = new Token(
        this.chainId,
        token.address,
        token.decimals,
        token.symbol,
        token.name
      );
    }
    this._ready = true;
  }

  public ready(): boolean {
    return this._ready;
  }

  /**
   * Router address.
   */
  public get router(): string {
    return this._router;
  }

  /**
   * Router smart contract ABI.
   */
  public get routerAbi(): ContractInterface {
    return this._routerAbi;
  }

  /**
   * Default gas limit for swap transactions.
   */
  public get gasLimitEstimate(): number {
    return this._gasLimitEstimate;
  }

  /**
   * Default time-to-live for swap transactions, in seconds.
   */
  public get ttl(): number {
    return this._ttl;
  }

  /**
   * Gets the allowed slippage percent from configuration.
   */
  getSlippagePercentage(): Percent {
    const allowedSlippage = LfgswapConfig.config.allowedSlippage;
    const nd = allowedSlippage.match(percentRegexp);
    if (nd) return new Percent(nd[1], nd[2]);
    throw new Error(
      'Encountered a malformed percent string in the config for ALLOWED_SLIPPAGE.'
    );
  }

  /**
   * Fetches information about a pair and constructs a pair from the given two tokens.
   * This is to replace the Fetcher Class
   * @param tokenA first token
   * @param tokenB second token
   */

  async fetchData(baseToken: Token, quoteToken: Token): Promise<Pair> {
    const pairAddress = Pair.getAddress(baseToken, quoteToken);
    const contract = new Contract(
      pairAddress,
      IUniswapV2Pair.abi,
      this.chain.provider
    );
    const [reserves0, reserves1] = await contract.getReserves();
    const balances = baseToken.sortsBefore(quoteToken)
      ? [reserves0, reserves1]
      : [reserves1, reserves0];
    const pair = new Pair(
      CurrencyAmount.fromRawAmount(baseToken, balances[0]),
      CurrencyAmount.fromRawAmount(quoteToken, balances[1])
    );
    return pair;
  }

  /**
   * Given the amount of `baseToken` to put into a transaction, calculate the
   * amount of `quoteToken` that can be expected from the transaction.
   *
   * This is typically used for calculating token sell prices.
   *
   * @param baseToken Token input for the transaction
   * @param quoteToken Output from the transaction
   * @param amount Amount of `baseToken` to put into the transaction
   */

  async estimateSellTrade(
    baseToken: Token,
    quoteToken: Token,
    amount: BigNumber
  ): Promise<ExpectedTrade> {
    const nativeTokenAmount: CurrencyAmount<Token> =
      CurrencyAmount.fromRawAmount(baseToken, amount.toString());

    logger.info(
      `Fetching pair data for ${baseToken.address}-${quoteToken.address}.`
    );

    const pair: Pair = await this.fetchData(baseToken, quoteToken);

    const trades: Trade<Token, Token, TradeType.EXACT_INPUT>[] =
      Trade.bestTradeExactIn([pair], nativeTokenAmount, quoteToken, {
        maxHops: 1,
      });
    if (!trades || trades.length === 0) {
      throw new UniswapishPriceError(
        `priceSwapIn: no trade pair found for ${baseToken} to ${quoteToken}.`
      );
    }
    logger.info(
      `Best trade for ${baseToken.address}-${quoteToken.address}: ` +
      `${trades[0].executionPrice.toFixed(6)}` +
      `${baseToken.name}.`
    );
    const expectedAmount = trades[0].minimumAmountOut(
      this.getSlippagePercentage()
    );

    return { trade: trades[0], expectedAmount };
  }
  async estimateBuyTrade(
    quoteToken: Token,
    baseToken: Token,
    amount: BigNumber
  ): Promise<ExpectedTrade> {
    const nativeTokenAmount: CurrencyAmount<Token> =
      CurrencyAmount.fromRawAmount(baseToken, amount.toString());

    const pair: Pair = await this.fetchData(quoteToken, baseToken);

    const trades: Trade<Token, Token, TradeType.EXACT_OUTPUT>[] =
      Trade.bestTradeExactOut([pair], quoteToken, nativeTokenAmount, {
        maxHops: 1,
      });
    if (!trades || trades.length === 0) {
      throw new UniswapishPriceError(
        `priceSwapOut: no trade pair found for ${quoteToken.address} to ${baseToken.address}.`
      );
    }
    logger.info(
      `Best trade for ${quoteToken.address}-${baseToken.address}: ` +
      `${trades[0].executionPrice.invert().toFixed(6)} ` +
      `${baseToken.name}.`
    );

    const expectedAmount = trades[0].maximumAmountIn(
      this.getSlippagePercentage()
    );
    return { trade: trades[0], expectedAmount };
  }

  /**
   * Given a wallet and a Uniswap trade, try to execute it on blockchain.
   *
   * @param _wallet Wallet
   * @param _trade Expected trade
   * @param _gasPrice Base gas price, for pre-EIP1559 transactions
   * @param uniswapRouter Router smart contract address
   * @param _ttl How long the swap is valid before expiry, in seconds
   * @param _abi Router contract ABI
   * @param _gasLimit Gas limit
   * @param _nonce (Optional) EVM transaction nonce
   * @param _maxFeePerGas (Optional) Maximum total fee per gas you want to pay
   * @param _maxPriorityFeePerGas (Optional) Maximum tip per gas you want to pay
   */

  async executeTrade(
    wallet: Wallet,
    trade: Trade<Token, Token, TradeType.EXACT_INPUT | TradeType.EXACT_OUTPUT>,
    gasPrice: number,
    sushswapRouter: string,
    ttl: number,
    abi: ContractInterface,
    gasLimit: number,
    nonce?: number,
    maxFeePerGas?: BigNumber,
    maxPriorityFeePerGas?: BigNumber
  ): Promise<Transaction> {
    const result: SwapParameters = Router.swapCallParameters(trade, {
      ttl,
      recipient: wallet.address,
      allowedSlippage: this.getSlippagePercentage(),
    });
    const contract: Contract = new Contract(sushswapRouter, abi, wallet);
    if (nonce === undefined) {
      nonce = await this.chain.nonceManager.getNextNonce(wallet.address);
    }
    let tx: ContractTransaction;
    if (maxFeePerGas !== undefined || maxPriorityFeePerGas !== undefined) {
      tx = await contract[result.methodName](...result.args, {
        gasLimit: gasLimit.toFixed(0),
        value: result.value,
        nonce: nonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
    } else {
      tx = await contract[result.methodName](...result.args, {
        gasPrice: (gasPrice * 1e9).toFixed(0),
        gasLimit: gasLimit.toFixed(0),
        value: result.value,
        nonce: nonce,
      });
    }

    logger.info(tx);
    await this.chain.nonceManager.commitNonce(wallet.address, nonce);
    return tx;
  }
}
