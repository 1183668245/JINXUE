import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

// 加载 .env 文件中的环境变量
dotenv.config();

const BSC_MAINNET_RPC_URL = process.env.BSC_MAINNET_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const config = {
  solidity: {
    version: "0.8.24", // 推荐的稳定编译器版本
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200 // 开启优化器，降低部署和运行的 Gas 费
      }
    }
  },
  networks: {
    hardhat: {
      chainId: 31337
    },
    bscMainnet: {
      url: BSC_MAINNET_RPC_URL || "",
      chainId: 56,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    }
  },
  etherscan: {
    // 用于验证 BSC 链上的开源合约
    apiKey: process.env.BSCSCAN_API_KEY
  }
};

export default config;