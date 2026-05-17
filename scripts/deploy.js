import hre from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const contractName = process.env.DEPLOY_CONTRACT_NAME;
  const previousFactoryAddress = process.env.PREVIOUS_FACTORY_ADDRESS || "";

  if (!contractName) {
    throw new Error("请在 .env 中配置 DEPLOY_CONTRACT_NAME");
  }

  if (contractName !== "GoldenBootVaultFactory") {
    throw new Error("当前脚本仅建议用于重新部署 GoldenBootVaultFactory");
  }

  console.log("=========================================");
  console.log(`开始部署 ${contractName}`);
  console.log("网络:", hre.network.name);
  console.log("=========================================");

  if (hre.network.name !== "bscMainnet") {
    throw new Error("当前部署脚本已收敛为正式网部署，请使用 --network bscMainnet");
  }

  // 获取部署账号
  const [deployer] = await hre.ethers.getSigners();
  console.log("部署账号地址:", deployer.address);
  
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("部署账号余额:", hre.ethers.formatEther(balance), "BNB");

  if (balance === 0n) {
      console.error("❌ 部署账号余额为 0，请先充值主网 BNB");
      process.exit(1);
  }

  console.log("\n正在部署 GoldenBootVault implementation...");
  const ImplFactory = await hre.ethers.getContractFactory("GoldenBootVault");
  const implArtifact = await hre.artifacts.readArtifact("GoldenBootVault");
  if (!implArtifact.bytecode || implArtifact.bytecode === "0x") {
    throw new Error("未找到 GoldenBootVault 的可部署字节码，请先编译");
  }
  const implementation = await ImplFactory.deploy();
  await implementation.waitForDeployment();
  const implementationAddress = await implementation.getAddress();
  console.log("👉 implementation 地址:", implementationAddress);

  console.log(`\n正在部署 ${contractName}...`);
  const ContractFactory = await hre.ethers.getContractFactory(contractName);
  const artifact = await hre.artifacts.readArtifact(contractName);
  if (!artifact.bytecode || artifact.bytecode === "0x") {
    throw new Error(`未找到 ${contractName} 的可部署字节码，请先编译`);
  }

  const deployed = await ContractFactory.deploy(implementationAddress);
  await deployed.waitForDeployment();
  const deployedAddress = await deployed.getAddress();

  console.log(`✅ ${contractName} 部署成功!`);
  console.log("👉 implementation 合约地址:", implementationAddress);
  console.log("👉 新工厂合约地址:", deployedAddress);
  if (previousFactoryAddress) {
    console.log("👉 旧工厂合约地址:", previousFactoryAddress);
    console.log("请在 FLAP Portal 中把旧地址替换为新地址。");
  }
  console.log("\n【下一步操作指南】");
  console.log("1. 在 FLAP 的税收模板入口填写上面的新工厂地址");
  console.log("2. 不要再使用旧工厂地址");
  console.log("3. 如页面仍不识别，请把新地址和报错信息发回来继续排查");
  console.log("=========================================");
}

main().catch((error) => {
  console.error("部署过程中发生错误:", error);
  process.exitCode = 1;
});