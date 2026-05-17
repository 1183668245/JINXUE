import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.BSC_MAINNET_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const VAULT_ADDRESS = process.env.VAULT_ADDRESS;

const VAULT_ABI = [
  "function getCurrentRoundInfo() external view returns (uint256 roundId, uint256 startAt, uint256 entryCloseAt, uint256 endTime, bool isDrawn, uint256 poolSnapshot, uint256 reward, uint32 winnerCount)",
  "function drawCurrentRound() external"
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!RPC_URL || !PRIVATE_KEY || !VAULT_ADDRESS) {
    throw new Error("请在 .env 中配置 BSC_MAINNET_RPC_URL、PRIVATE_KEY、VAULT_ADDRESS");
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

  console.log("keeper 已启动");
  console.log("网络: BSC Mainnet");
  console.log("执行地址:", wallet.address);
  console.log("金库地址:", VAULT_ADDRESS);
  console.log("RPC:", RPC_URL);

  while (true) {
    try {
      const round = await vault.getCurrentRoundInfo();
      const latestBlock = await provider.getBlock("latest");
      const now = Number(latestBlock.timestamp);

      const roundId = Number(round[0]);
      const endTime = Number(round[3]);
      const isDrawn = round[4];

      console.log(`[检查] 轮次=${roundId} now=${now} end=${endTime} drawn=${isDrawn}`);

      if (!isDrawn && now >= endTime) {
        console.log(`[执行] 第 ${roundId} 轮满足开奖条件，发送 drawCurrentRound()`);
        const tx = await vault.drawCurrentRound();
        console.log(`[已发送] tx=${tx.hash}`);
        await tx.wait();
        console.log(`[成功] 第 ${roundId} 轮开奖完成`);
      }
    } catch (err) {
      console.error("[异常]", err?.shortMessage || err?.message || err);
    }

    await sleep(15000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});