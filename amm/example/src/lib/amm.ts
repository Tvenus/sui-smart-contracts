/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  Coin,
  getMoveObjectType,
  GetObjectDataResponse,
  getObjectId,
  JsonRpcProvider,
} from '@mysten/sui.js'
import { SuiWalletAdapter } from '@mysten/wallet-adapter-all-wallets'
import { ceilDiv, min } from './bigint-math'
import { getOrCreateCoinOfLargeEnoughBalance } from './coin'
import { getWalletAddress } from './util'

/* ============================== constants ================================= */

const AMM_PACKAGE_ID =
  import.meta.env.VITE_AMM_PACKAGE_ID || '0x88bbd38f27daaf1ac6ee362147865ca500da5d8'

const POOL_TYPE_REGEX = new RegExp(`^${AMM_PACKAGE_ID}::amm::Pool<(.+), (.+)>$`)
const LP_COIN_TYPE_REGEX = new RegExp(`^${AMM_PACKAGE_ID}::amm::LPCoin<(.+), (.+)>$`)

const BPS_IN_100_PCT = 100_00

/* =========================== helper functions ============================= */

export function objectIsPool(obj: GetObjectDataResponse): boolean {
  return !!getMoveObjectType(obj)?.match(POOL_TYPE_REGEX)
}

export async function getPools(provider: JsonRpcProvider): Promise<GetObjectDataResponse[]> {
  // hard code for now because the below doesn't work
  return await provider.getObjectBatch(['0x81de257f41e61e6bd70a3e9adf37f68fbcfc2e07'])

  /*
  // there's currently no way to fetch shared objects directly so this is a hacky way to do it
  const events = await provider.getEventsByModule(AMM_PACKAGE_ID, 'amm')
  const createdObjIDs = events.flatMap(event_ => {
    const event = event_.event
    if ('newObject' in event) {
      return event.newObject.objectId
    }
    return []
  })
  const createdObjs = await provider.getObjectBatch(createdObjIDs)

  return createdObjs.filter(objectIsPool)
  */
}

export function getPoolCoinTypeArgs(obj: GetObjectDataResponse): [string, string] {
  const type = getMoveObjectType(obj)
  if (type === undefined) {
    throw new Error('the provided object is not a pool')
  }
  const m = type.match(POOL_TYPE_REGEX)!
  return [m[1], m[2]]
}

export function getPoolsUniqueCoinTypeArgs(pools: GetObjectDataResponse[]): string[] {
  const seen = new Set<string>()
  pools.forEach(pool => {
    const args = getPoolCoinTypeArgs(pool)
    seen.add(args[0])
    seen.add(args[1])
  })

  return Array.from(seen.values())
}

// Returns pool balances [<balanceA>, <balanceB>, <lpSupply>]
export function getPoolBalances(pool: GetObjectDataResponse): [bigint, bigint, bigint] {
  return [
    BigInt((pool as any).details.data.fields.balance_a),
    BigInt((pool as any).details.data.fields.balance_b),
    BigInt((pool as any).details.data.fields.lp_supply.fields.value),
  ]
}

// Returns pool fees [<lpFeeBPS>, <adminFee>]
export function getPoolFees(pool: GetObjectDataResponse): [number, number] {
  return [
    (pool as any).details.data.fields.lp_fee_bps,
    (pool as any).details.data.fields.admin_fee_pct,
  ]
}

/// Based on first coin type arg and a list of pools, returns all possible other
/// coin type args for swap (so that a pool exists for each of those pairs)
export function getPossibleSecondCoinTypeArgs(
  pools: GetObjectDataResponse[],
  firstCoinTypeArg: string
): string[] {
  const seen = new Set<string>()
  pools.forEach(pool => {
    const args = getPoolCoinTypeArgs(pool)
    if (args[0] === firstCoinTypeArg) {
      seen.add(args[1])
    }
    if (args[1] === firstCoinTypeArg) {
      seen.add(args[0])
    }
  })

  return Array.from(seen.values())
}

// Provided a list of pool objects, selects one matching the pair. If there are multiple
// valid pools for the provided pair, returns the first one from the list. The pair order
// is irreleveant (can return either Pool<A, B> or Pool<B, A> for provided pair [A, B]).
export function selectPoolForPair(
  pools: GetObjectDataResponse[],
  pairCoinTypeArgs: [string, string]
): GetObjectDataResponse | undefined {
  for (const pool of pools) {
    const poolPair = getPoolCoinTypeArgs(pool)
    if (
      (poolPair[0] === pairCoinTypeArgs[0] && poolPair[1] === pairCoinTypeArgs[1]) ||
      (poolPair[0] === pairCoinTypeArgs[1] && poolPair[1] === pairCoinTypeArgs[0])
    ) {
      return pool
    }
  }
}

export function calcSwapAmountOut(
  pool: GetObjectDataResponse,
  inputCoinTypeArg: string,
  inputAmount: bigint
) {
  const poolTypeArgs = getPoolCoinTypeArgs(pool)
  const poolBalances = getPoolBalances(pool)
  const poolLpFees = getPoolFees(pool)[0]

  let inputPoolBalance: bigint
  let outputPoolBalance: bigint
  if (inputCoinTypeArg === poolTypeArgs[0]) {
    inputPoolBalance = poolBalances[0]
    outputPoolBalance = poolBalances[1]
  } else if (inputCoinTypeArg === poolTypeArgs[1]) {
    inputPoolBalance = poolBalances[1]
    outputPoolBalance = poolBalances[0]
  } else {
    throw new Error('invalid input coin for pool')
  }

  const inputAmountAfterFees =
    inputAmount - ceilDiv(inputAmount * BigInt(poolLpFees), BigInt(BPS_IN_100_PCT))
  const out = (inputAmountAfterFees * outputPoolBalance) / (inputPoolBalance + inputAmountAfterFees)

  return out
}

export function calcPoolOtherDepositAmount(
  pool: GetObjectDataResponse,
  amount: bigint,
  typeArg: string
): bigint {
  const poolTypeArgs = getPoolCoinTypeArgs(pool)
  const poolBalances = getPoolBalances(pool)

  if (typeArg === poolTypeArgs[0]) {
    return (amount * poolBalances[1]) / poolBalances[0]
  } else if (typeArg === poolTypeArgs[1]) {
    return (amount * poolBalances[0]) / poolBalances[1]
  } else {
    throw new Error(`${typeArg} not in pool`)
  }
}

export function calcPoolLpValue(pool: GetObjectDataResponse, lpAmount: bigint): [bigint, bigint] {
  const [balanceA, balanceB, poolLpAmount] = getPoolBalances(pool)
  const amountA = (balanceA * lpAmount) / poolLpAmount
  const amountB = (balanceB * lpAmount) / poolLpAmount

  return [amountA, amountB]
}

export function typeIsLpCoin(type: string): boolean {
  return !!type.match(LP_COIN_TYPE_REGEX)
}

export function objectIsLpCoin(obj: GetObjectDataResponse): boolean {
  return typeIsLpCoin(getMoveObjectType(obj)!)
}

export function getLpCoinTypeArgs(obj: GetObjectDataResponse): [string, string] {
  const type = getMoveObjectType(obj)
  if (type === undefined) {
    throw new Error('the provided object is not a pool')
  }
  const m = type.match(LP_COIN_TYPE_REGEX)!
  return [m[1], m[2]]
}

export async function getUserLpCoins(
  provider: JsonRpcProvider,
  wallet: SuiWalletAdapter
): Promise<GetObjectDataResponse[]> {
  const addr = await getWalletAddress(wallet)
  const infos = (await provider.getObjectsOwnedByAddress(addr)).filter(info =>
    typeIsLpCoin(info.type)
  )

  return await provider.getObjectBatch(infos.map(info => info.objectId))
}

export function getLpCoinPoolId(lpCoin: GetObjectDataResponse): string {
  return (lpCoin as any).details.data.fields.pool_id
}

export function getLpCoinBalance(lpCoin: GetObjectDataResponse): bigint {
  return BigInt((lpCoin as any).details.data.fields.balance)
}

/* =========================== smart contract calls ========================= */

export interface CreatePoolParams {
  typeA: string
  initAmountA: bigint
  typeB: string
  initAmountB: bigint
  lpFeeBps: number
  adminFeePct: number
}

export async function createPool(
  provider: JsonRpcProvider,
  wallet: SuiWalletAdapter,
  params: CreatePoolParams
) {
  const [inputA, inputB] = await Promise.all([
    getOrCreateCoinOfLargeEnoughBalance(provider, wallet, params.typeA, params.initAmountA),
    getOrCreateCoinOfLargeEnoughBalance(provider, wallet, params.typeB, params.initAmountB),
  ])

  // create pool
  const res = await wallet.signAndExecuteTransaction({
    kind: 'moveCall',
    data: {
      packageObjectId: AMM_PACKAGE_ID,
      module: 'periphery',
      function: 'maybe_split_then_create_pool',
      typeArguments: [params.typeA, params.typeB],
      arguments: [
        Coin.getID(inputA),
        params.initAmountA.toString(),
        Coin.getID(inputB),
        params.initAmountB.toString(),
        params.lpFeeBps,
        params.adminFeePct,
      ],
      gasBudget: 10000,
    },
  })
  console.debug(res)
}

export async function swap(
  provider: JsonRpcProvider,
  wallet: SuiWalletAdapter,
  pool: GetObjectDataResponse,
  inputCoinTypeArg: string,
  amount: bigint,
  maxSlippagePct: number
) {
  const poolTypeArgs = getPoolCoinTypeArgs(pool)
  const poolBalances = getPoolBalances(pool)
  const poolLpFees = getPoolFees(pool)[0]

  const inputCoin = await getOrCreateCoinOfLargeEnoughBalance(
    provider,
    wallet,
    inputCoinTypeArg,
    amount
  )

  let direction: 'A_TO_B' | 'B_TO_A'
  let inputPoolBalance: bigint
  let outputPoolBalance: bigint
  if (inputCoinTypeArg === poolTypeArgs[0]) {
    direction = 'A_TO_B'
    inputPoolBalance = poolBalances[0]
    outputPoolBalance = poolBalances[1]
  } else if (inputCoinTypeArg === poolTypeArgs[1]) {
    direction = 'B_TO_A'
    inputPoolBalance = poolBalances[1]
    outputPoolBalance = poolBalances[0]
  } else {
    throw new Error('invalid input coin for pool')
  }

  const inputAmount = amount
  const inputAmountAfterFees =
    inputAmount - ceilDiv(inputAmount * BigInt(poolLpFees), BigInt(BPS_IN_100_PCT))
  const minOut =
    (inputAmountAfterFees * outputPoolBalance * BigInt(100 - maxSlippagePct)) /
    ((inputPoolBalance + inputAmountAfterFees) * BigInt(100))

  const res = await wallet.signAndExecuteTransaction({
    kind: 'moveCall',
    data: {
      packageObjectId: AMM_PACKAGE_ID,
      module: 'periphery',
      function: direction === 'A_TO_B' ? 'maybe_split_then_swap_a' : 'maybe_split_then_swap_b',
      typeArguments: poolTypeArgs,
      arguments: [getObjectId(pool), getObjectId(inputCoin), amount.toString(), minOut.toString()],
      gasBudget: 10000,
    },
  })
  console.debug(res)
}

export async function deposit(
  provider: JsonRpcProvider,
  wallet: SuiWalletAdapter,
  pool: GetObjectDataResponse,
  amountA: bigint,
  amountB: bigint,
  slippagePct: number
) {
  const poolTypeArgs = getPoolCoinTypeArgs(pool)

  const poolBalances = getPoolBalances(pool)
  // TODO: calc min out more precisely (based on price slippage and not lp out slippage)
  const expLpOutBasedOnA = (amountA * poolBalances[2]) / poolBalances[0]
  const expLpOutBasedOnB = (amountB * poolBalances[2]) / poolBalances[1]
  const minOut = min(
    (expLpOutBasedOnA * BigInt(100 - slippagePct)) / 100n,
    (expLpOutBasedOnB * BigInt(100 - slippagePct)) / 100n
  )

  const [coinA, coinB] = await Promise.all([
    getOrCreateCoinOfLargeEnoughBalance(provider, wallet, poolTypeArgs[0], amountA),
    getOrCreateCoinOfLargeEnoughBalance(provider, wallet, poolTypeArgs[1], amountB),
  ])

  const res = await wallet.signAndExecuteTransaction({
    kind: 'moveCall',
    data: {
      packageObjectId: AMM_PACKAGE_ID,
      module: 'periphery',
      function: 'maybe_split_then_deposit',
      typeArguments: poolTypeArgs,
      arguments: [
        getObjectId(pool),
        getObjectId(coinA),
        amountA.toString(),
        getObjectId(coinB),
        amountB.toString(),
        minOut.toString(),
      ],
      gasBudget: 10000,
    },
  })
  console.debug(res)
}

export async function withdraw(
  provider: JsonRpcProvider,
  wallet: SuiWalletAdapter,
  lpCoin: GetObjectDataResponse,
  slippagePct: number
) {
  const poolId = getLpCoinPoolId(lpCoin)
  const pool = await provider.getObject(poolId)
  const poolBalances = getPoolBalances(pool)
  const lpCoinBalance = getLpCoinBalance(lpCoin)

  const minA =
    (lpCoinBalance * poolBalances[0] * BigInt(100 - slippagePct)) / (poolBalances[2] * 100n)
  const minB =
    (lpCoinBalance * poolBalances[1] * BigInt(100 - slippagePct)) / (poolBalances[2] * 100n)

  const res = await wallet.signAndExecuteTransaction({
    kind: 'moveCall',
    data: {
      packageObjectId: AMM_PACKAGE_ID,
      module: 'amm',
      function: 'withdraw_',
      typeArguments: getPoolCoinTypeArgs(pool),
      arguments: [getObjectId(pool), getObjectId(lpCoin), minA.toString(), minB.toString()],
      gasBudget: 10000,
    },
  })
  console.debug(res)
}
