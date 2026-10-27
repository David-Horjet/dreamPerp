// Places one small perps order on Somnia Tokyo (Hideki) testnet and prints the tx hash.
//
//   npm run first-order              # DRY_RUN=true by default: reads and sizes, sends nothing
//   DRY_RUN=false npm run first-order
//
// Two modes:
//   • OWNER_ADDRESS set: PRIVATE_KEY is a bot key linked to that dreamDEX account
//     (app → wallet → Link a bot → Perps). Orders go through placeOrderFor, so margin
//     and fills are the account's; the bot key only signs and pays gas.
//   • OWNER_ADDRESS blank: PRIVATE_KEY trades its own account, claiming the one-time
//     paper USDso voucher first if eligible.

import "dotenv/config";
import {
  ORDER_TYPE,
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
  contractErrorsAbi,
  decodePlaceOrder,
  type UnifiedMarket,
} from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, createWalletClient, formatUnits, getAddress, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = "https://api.hideki2.infra.testnet.somnia.network";
const WS_RPC_URL = "wss://api.hideki2.infra.testnet.somnia.network/ws";
const INDEXER_URL = "https://hideki-dev.smk.somnia.host/v1/graphql";

const SYMBOL = (process.env.PERP_SYMBOL ?? "ETH-PERP").trim().toUpperCase().replace(/-PERP$/, "");
const SIDE = (process.env.PERP_SIDE ?? "long").trim().toLowerCase() === "short" ? "short" : "long";
const NOTIONAL = Number(process.env.PERP_NOTIONAL_USDSO ?? 20);
const SLIPPAGE_BPS = 30n;
const DRY_RUN = process.env.DRY_RUN !== "false";

// The SDK has no perp `…For` writes, so a linked bot key calls the pool directly.
const OPERATOR_ABI = [
  ...parseAbi([
    "function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)",
    "function isOperatorAuthorized(address owner, address operator, bytes4 selector) view returns (bool)",
  ]),
  ...contractErrorsAbi,
] as const;
const PLACE_ORDER_FOR_SELECTOR = "0x80054449";
const ORDER_GAS = 10_000_000n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

interface PerpInfo {
  poolAddress: `0x${string}`;
  marginBank: `0x${string}`;
  baseSymbol: string;
  baseDecimals: number;
  tickSize: string;
  lotSize: string;
  minQuantity: string;
}

function alignDown(value: bigint, step: bigint): bigint {
  return step > 0n ? (value / step) * step : value;
}

// toFixed to <= 9 places keeps the conversion exact; toFixed(18) drifts off the grid.
function toRaw(human: number, decimals: number): bigint {
  const [i = "0", f = ""] = human.toFixed(Math.min(decimals, 9)).split(".");
  return BigInt(i + f.padEnd(decimals, "0").slice(0, decimals));
}

async function main(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY?.trim() as `0x${string}` | undefined;
  if (!privateKey || privateKey === "0x") throw new Error("Set PRIVATE_KEY in .env (a testnet-only key).");
  const ownerRaw = process.env.OWNER_ADDRESS?.trim();
  const owner = ownerRaw ? getAddress(ownerRaw) : undefined;
  const botKey = privateKeyToAccount(privateKey);

  // With an owner the SDK is read-only for that account: positions, margin and sizing are the owner's.
  const markets = new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl: INDEXER_URL,
    wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
    ...(owner ? { account: owner } : { privateKey }),
  });
  const account = owner ?? botKey.address;
  const publicClient = createPublicClient({ chain: hidekiTestnet, transport: http(RPC_URL) });

  // Perps arrive as ccxt swaps, e.g. "ETH/USDso:USDso".
  const all = Object.values(await markets.loadMarkets()) as UnifiedMarket[];
  const perps = all.filter((m) => m.type === "swap" && m.active);
  const market = perps.find((m) => m.symbol.split("/")[0]?.toUpperCase() === SYMBOL);
  if (!market) {
    throw new Error(`No live ${SYMBOL}-PERP. Live: ${perps.map((m) => m.symbol.split("/")[0]).join(", ")}`);
  }
  const info = market.info as unknown as PerpInfo;
  console.log(
    `account ${account}${owner ? ` via bot key ${botKey.address}` : ""} | ${SYMBOL}-PERP pool ${info.poolAddress} | dry-run ${DRY_RUN}`,
  );

  if (owner) {
    const linked = await publicClient.readContract({
      address: info.poolAddress,
      abi: OPERATOR_ABI,
      functionName: "isOperatorAuthorized",
      args: [owner, botKey.address, PLACE_ORDER_FOR_SELECTOR],
    });
    const gas = await publicClient.getBalance({ address: botKey.address });
    console.log(`bot key linked for ${SYMBOL}-PERP: ${linked} | bot gas ${formatUnits(gas, 18)} STT`);
    if (!linked && !DRY_RUN) {
      throw new Error(`Link ${botKey.address} in the app: wallet → Link a bot → keep Perps ticked → Add bot.`);
    }
    if (gas === 0n && !DRY_RUN) throw new Error(`Send some STT to the bot key ${botKey.address} for gas.`);
  } else {
    const eligibility = await markets.client.getPerpVoucherEligibility(info.marginBank, account);
    if (eligibility.eligible) {
      if (DRY_RUN) {
        console.log("[dry-run] would claim the paper USDso voucher");
      } else {
        const claim = await markets.trader.claimPerpVoucher({ marginBank: info.marginBank });
        console.log(`claimed paper USDso voucher | tx ${claim.hash}`);
      }
    } else {
      console.log(`voucher not claimable (${eligibility.reason}), trading the existing balance`);
    }
  }

  const book = await markets.fetchOrderBook(market.symbol, 1);
  const touch = SIDE === "long" ? book.asks[0]?.[0] : book.bids[0]?.[0];
  if (touch === undefined) throw new Error("No resting liquidity on the side this order would cross.");

  // An IOC at exactly the touch reverts ImmediateOrCancelNoFill if that level moves; pay a little past it.
  const tick = BigInt(info.tickSize);
  const touchRaw = toRaw(touch, 18);
  const price = alignDown(
    SIDE === "long" ? (touchRaw * (10_000n + SLIPPAGE_BPS)) / 10_000n : (touchRaw * (10_000n - SLIPPAGE_BPS)) / 10_000n,
    tick,
  );

  const wanted = alignDown(toRaw(NOTIONAL / touch, info.baseDecimals), BigInt(info.lotSize));
  const max = await markets.client.getMaxPerpOrderSize({
    pool: info.poolAddress,
    marginBank: info.marginBank,
    account,
    isBid: SIDE === "long",
    price,
  });
  if (!max.priceable) throw new Error("Market is un-priceable right now (stale mark). Try again shortly.");
  if (!DRY_RUN && !max.placeable) {
    throw new Error(
      `Cannot place: limitedBy=${max.limitedBy}. ` +
        (owner ? "Move USDso from Spot wallet to Perps account in the app (Perps ⇆ Spot)." : ""),
    );
  }
  const capped = DRY_RUN || wanted < max.maxQuantity ? wanted : max.maxQuantity;
  const quantity = alignDown(capped, BigInt(info.lotSize));
  if (quantity < BigInt(info.minQuantity)) {
    throw new Error(`Size ${formatUnits(quantity, info.baseDecimals)} is below the market minimum.`);
  }

  const what = `${SIDE} ${formatUnits(quantity, info.baseDecimals)} ${info.baseSymbol} @ <= ${formatUnits(price, 18)}`;
  if (DRY_RUN) {
    console.log(`[dry-run] would place IOC ${what} (pool allows up to ${max.maxQuantity}, limitedBy ${max.limitedBy})`);
    return;
  }

  let hash: `0x${string}`;
  let fills;
  if (owner) {
    const walletClient = createWalletClient({ account: botKey, chain: hidekiTestnet, transport: http(RPC_URL) });
    const expireNs = BigInt(Math.floor(Date.now() / 1000) + 50 * 365 * 24 * 3600) * 1_000_000_000n;
    // Simulate first so a revert surfaces with its named error instead of a bare status 0.
    const { request } = await publicClient.simulateContract({
      address: info.poolAddress,
      abi: OPERATOR_ABI,
      functionName: "placeOrderFor",
      args: [owner, SIDE === "long", 0n, price, quantity, expireNs, ORDER_TYPE.MARKET, 0, ZERO_ADDRESS, 0n],
      account: botKey,
      gas: ORDER_GAS,
    });
    hash = await walletClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Order reverted on-chain: tx ${hash}`);
    fills = decodePlaceOrder(receipt, info.poolAddress).fills;
  } else {
    const res = await markets.trader.placePerpOrder({
      pool: info.poolAddress,
      isBid: SIDE === "long",
      price,
      quantity,
      orderType: ORDER_TYPE.MARKET,
    });
    if (res.receipt.status === "reverted") throw new Error(`Order reverted on-chain: tx ${res.hash}`);
    hash = res.hash;
    fills = res.fills;
  }
  const filled = fills.reduce((sum, f) => sum + f.quantityFilled, 0n);
  console.log(`placed IOC ${what} | filled ${formatUnits(filled, info.baseDecimals)} | tx ${hash}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
