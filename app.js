const CONFIG = {
  CHAIN_ID: 56,
  CHAIN_NAME: "BNB Smart Chain",
  RPC_URL: "https://rpc.ankr.com/bsc/a26683b94cba4a37f4d0740f37de396a3101a8a28396797705098a47c60a5587",
  RPC_WS_URL: "wss://rpc.ankr.com/bsc/ws/a26683b94cba4a37f4d0740f37de396a3101a8a28396797705098a47c60a5587",
  EXPLORER_URL: "https://bscscan.com",
  CURRENCY_SYMBOL: "BNB",
  TOKEN_ADDRESS: "0xcf4f868e0813645ae6b1468a2da21e511bd47777",
  VAULT_ADDRESS: "0x806b0209509F8547a6fEDC9797477246cbdeEF7b", // 当前已部署 GoldenBootVault 地址
};

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)"
];

const VAULT_ABI = [
  "function trainingPool() external view returns (uint256)",
  "function gloryPool() external view returns (uint256)",
  "function curRound() external view returns (uint256)",
  "function description() external view returns (string)",
  "function activeBuybackToken() external view returns (address)",
  "function canExecuteBuyback() external view returns (bool)",
  "function getCurrentRoundInfo() external view returns (uint256 roundId, uint256 startAt, uint256 entryCloseAt, uint256 endTime, bool isDrawn, uint256 poolSnapshot, uint256 reward, uint32 winnerCount)",
  "function getProposalInfo(uint256 pId) external view returns (string title, address target, uint256 startTime, uint256 endTime, uint256 yesVotes, uint256 noVotes, bool settled, bool passed)",
  "function getVoteInfo(uint256 pId, address user) external view returns (uint256 amount, bool isYes, bool withdrawn, uint256 unlockTime)",
  "function enterTrainingGround(uint8 n1, uint8 n2, uint8 n3) external",
  "function drawCurrentRound() external",
  "function claimTrainingReward(uint256 roundId) external",
  "function claimAllTrainingRewards(uint256[] roundIds) external",
  "function sweepExpiredRound(uint256 roundId) external",
  "function getTicketStatus(uint256 roundId, address user) external view returns (bool entered, bool winning, bool claimed, bool forfeited, uint8 matchCount)",
  "function getRoundTicket(uint256 rId, address user) external view returns (uint16 choiceKey, uint8[3] nums, bool claimed, bool exists, bool forfeited)",
  "function getRoundResult(uint256 rId) external view returns (uint256 startAt, uint256 entryCloseAt, uint256 endTime, uint256 claimDeadline, uint256 poolSnapshot, uint256 releasedAmount, uint256 reward, uint32 winnerCount, uint32 claimedCount, uint16 winningChoiceKey, uint8[3] winNums, uint8 highMatch, bool isDrawn, bool swept)",
  "function pCount() external view returns (uint256)",
  "function createProposal(address targetToken, string title) external",
  "function vote(uint256 proposalId, uint256 amount, bool isYes) external",
  "function settleProposal(uint256 proposalId) external",
  "function withdrawVote(uint256 proposalId) external",
  "function executeBuyback(bytes calldata swapData) external",
  "function taxToken() external view returns (address)",
  "function getRoundMinPlayThreshold(uint256 roundId) external view returns (uint256)"
];

let provider;
let signer;
let account;
let vaultContract;
let tokenContract;
let pendingAction = false;
let pendingActionLabel = "";
let tokenDecimals = 18;
const tokenSymbolCache = new Map();
let walletListenersBound = false;
let roundClockTimer;
let roundSyncTimer;
let roundSyncBusy = false;
let roundSyncIntervalMs = 0;
let chainTimeOffsetMs = 0;
let latestRoundInfo;
let suppressResetUntil = 0;
let trainingRecordsRefreshController = null;
let trainingEligibilityState = "waiting";
let trainingEnteredCurrentRound = false;
let currentRoundTicketNums = [];

const SESSION_KEYS = {
  AUTO_CONNECT: "golden_boot_auto_connect"
};

const TRAINING_RECORD_BATCH_SIZE = 20;
const TRAINING_RECORD_RECENT_RESYNC = 20;
const TRAINING_REWARD_CACHE_TTL_MS = 30000;
const ROUND_SYNC_INTERVAL_NORMAL = 5000;
const ROUND_SYNC_INTERVAL_LOCKED = 1500;

const $ = (id) => document.getElementById(id);

function detectWalletEnvironment() {
  const ua = navigator.userAgent.toLowerCase();
  const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
  const known = [
    [window.ethereum?.isOkxWallet || ua.includes("okx"), "OKX Wallet"],
    [window.ethereum?.isBitKeep || ua.includes("bitkeep") || ua.includes("tpwallet") || ua.includes("tokenpocket"), "钱包浏览器"],
    [window.ethereum?.isCoinbaseWallet || ua.includes("coinbasewallet"), "Coinbase Wallet"],
    [ua.includes("trust") && ua.includes("wallet"), "Trust Wallet"],
    [ua.includes("imtoken"), "imToken"]
  ];
  const name = known.find(([matched]) => matched)?.[1] || "";
  return { isMobile, isWalletApp: !!name || (isMobile && !!window.ethereum), name };
}

function getWalletOpenHint() {
  const env = detectWalletEnvironment();
  if (window.ethereum) return env.isWalletApp ? `已检测到${env.name || "钱包浏览器"}，点击授权连接后即可继续。` : "已检测到钱包环境，点击连接钱包后继续。";
  return env.isMobile ? "请在 OKX、TokenPocket、Trust Wallet 等钱包 App 内打开链接后再连接。" : "请先安装支持 EVM 的钱包后再连接。";
}

function getNetworkHelpText() {
  return `请切到 ${CONFIG.CHAIN_NAME}（Chain ID ${CONFIG.CHAIN_ID}）。如果钱包未自动切换，请在钱包网络列表中手动切换后重试。`;
}

function updateWalletContextUI() {
  const btn = $("connectBtn");
  const hint = $("walletEnvHint");
  const env = detectWalletEnvironment();
  if (btn && !account) {
    btn.textContent = env.isWalletApp ? "授权连接钱包" : "连接钱包";
    btn.title = getWalletOpenHint();
  }
  if (!hint) return;
  hint.classList.add("hidden");
  hint.textContent = "";
}

function setRewardSummaryText(text) {
  const el = $("unclaimedRewardTotal");
  if (!el) return;
  if ("value" in el) el.value = text;
  else el.textContent = text;
}

function setRewardSummaryState(state = "idle", detail = "参与训练后这里会汇总奖励") {
  const badge = $("trainingRewardStatus");
  const count = $("trainingRewardCount");
  const claimAllBtn = $("claimAllBtn");
  if (badge) {
    badge.className = `training-reward-status ${state}`;
    badge.textContent = state === "pending" ? "待领取中" : state === "ready" ? "暂无待领取" : "尚未参与";
  }
  if (count) count.textContent = detail;
  if (claimAllBtn) {
    const enabled = state === "pending";
    claimAllBtn.disabled = !enabled;
    claimAllBtn.title = enabled ? "" : "当前没有可领取的历史累计奖励";
  }
}

function setButtonLoadingState(button, loading, idleText, busyText) {
  if (!button) return;
  button.classList.toggle("is-loading", loading);
  button.textContent = loading ? busyText : idleText;
}

function setActionPhase(buttonId, actionLabel, idleText, phaseText) {
  const btn = $(buttonId);
  if (btn) setButtonLoadingState(btn, true, idleText, phaseText);
  if (pendingAction) pendingActionLabel = `${actionLabel}（${phaseText}）`;
}

function renderCurrentRoundTicket(roundId = 0, nums = []) {
  const box = $("currentRoundTicketBox");
  if (!box) return;
  const items = Array.from(nums || []).map(Number).filter(Boolean);
  if (!items.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = `<div class="current-round-ticket-head"><strong>本轮已提交</strong><span>第 ${roundId} 轮 · 本轮不可重复参与</span></div><div class="current-round-ticket-row">${items.map((n) => `<div class="current-round-ticket-item"><img src="./素材/球员/${n}.webp" alt="球员${n}" /><span>${n}号球员</span></div>`).join("")}</div>`;
}

function setPill(id, text, cls) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = `pill ${cls}`;
}

function shortAccount(addr) {
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "0x----";
}

function setWalletMenuConnected(connected) {
  $("connectBtn")?.classList.toggle("hidden", connected);
  $("walletMenuWrap")?.classList.toggle("hidden", !connected);
}

function closeWalletDropdown() {
  $("walletDropdown")?.classList.add("hidden");
}

function must(id) {
  const el = $(id);
  if (!el) {
    throw new Error(`页面缺少必要元素: #${id}`);
  }
  return el;
}

function log(msg) {
  const box = $("logBox");
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  if (!box) {
    console.log(line);
    return;
  }
  box.value = box.value ? `${line}\n${box.value}` : line;
}

let lastToastKey = "";
let lastToastAt = 0;
let lastClaimReminderKey = "";

const CACHE_KEYS = {
  ROUND_RESULT: "golden_boot_round_result_cache",
  TRAINING_RECORDS: "golden_boot_training_records_cache",
  PROPOSALS: "golden_boot_proposals_cache"
};

let proposalRefreshBusy = false;

function saveCache(key, payload) {
  try {
    localStorage.setItem(key, JSON.stringify({ ...payload, savedAt: Date.now() }));
  } catch {}
}

function loadCache(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getFreshPendingRewardRoundIds() {
  const cache = loadCache(CACHE_KEYS.TRAINING_RECORDS);
  const ids = Array.isArray(cache?.pendingWinnerRoundIds) ? cache.pendingWinnerRoundIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  return Date.now() - Number(cache?.savedAt || 0) <= TRAINING_REWARD_CACHE_TTL_MS ? ids : [];
}

function applyClaimAllLocalRewardState() {
  const cache = loadCache(CACHE_KEYS.TRAINING_RECORDS);
  const records = Array.isArray(cache?.records) ? cache.records : [];
  renderTrainingRecords(records, "0 BNB");
  setRewardSummaryState(records.length ? "ready" : "idle", records.length ? `已累计参与 ${records.length} 轮训练` : "参与训练后这里会汇总奖励");
  if (cache) saveCache(CACHE_KEYS.TRAINING_RECORDS, { ...cache, pendingWinnerRoundIds: [], pendingRewardText: "0 BNB" });
}

function buildRoundAvatarItems(nums = []) {
  return (nums || []).map((n) => `<div class="history-avatar-item"><img src="./素材/球员/${Number(n)}.webp" alt="球员${Number(n)}" /><span>${Number(n)}号球员</span></div>`).join("");
}

function renderRoundResultCard(payload) {
  const box = $("roundResultBox");
  if (!box) return;
  if (!payload) {
    box.className = "history-result-card empty";
    box.innerHTML = '<div class="training-record-empty">输入轮次后查看开奖结果</div>';
    return;
  }
  box.className = "history-result-card";
  box.innerHTML = `<div class="history-result-head"><strong>轮次 ${payload.roundId}</strong><span class="training-record-pill ${payload.drawn ? "win" : "miss"}">${payload.drawn ? "已开奖" : "未开奖"}</span></div><div class="history-avatar-row">${buildRoundAvatarItems(payload.nums)}</div><div class="history-result-grid"><div class="history-result-stat"><span>最高命中</span><strong>${payload.highMatch}</strong></div><div class="history-result-stat"><span>中奖人数</span><strong>${payload.winnerCount}</strong></div><div class="history-result-stat"><span>单人奖励</span><strong>${payload.rewardText}</strong></div><div class="history-result-stat"><span>领奖截止</span><strong>${payload.deadlineText}</strong></div></div>`;
}

function restoreCachedPanels() {
  const roundCache = loadCache(CACHE_KEYS.ROUND_RESULT);
  if (roundCache) {
    if ($("roundResultId") && roundCache.roundId) $("roundResultId").value = roundCache.roundId;
    renderRoundResultCard(roundCache.payload || null);
  }

  const recordsCache = loadCache(CACHE_KEYS.TRAINING_RECORDS);
  if (recordsCache) {
    const records = Array.isArray(recordsCache.records) ? recordsCache.records : parseLegacyTrainingRecords(recordsCache.text || "");
    renderTrainingRecords(records, recordsCache.pendingRewardText || "0 BNB");
  }
}

function openTrainingRecordsModal() {
  $("trainingRecordsModal")?.classList.remove("hidden");
}

function closeTrainingRecordsModal() {
  $("trainingRecordsModal")?.classList.add("hidden");
}

async function openHistoryModal() {
  $("historyModal")?.classList.remove("hidden");
  const latestSettledRound = Math.max(1, latestRoundInfo ? Number(latestRoundInfo[0]) - 1 : Number($("curRound")?.textContent || 1) - 1 || 1);
  renderHistoryQuickRounds(latestSettledRound, latestSettledRound);
  if ($("roundResultId") && !$("roundResultId").value) $("roundResultId").value = String(latestSettledRound);
  try {
    await queryRoundResultById(Number($("roundResultId")?.value || latestSettledRound), { silent: true });
  } catch {}
}

function closeHistoryModal() {
  $("historyModal")?.classList.add("hidden");
}

function openTrainingRulesModal() {
  $("trainingRulesModal")?.classList.remove("hidden");
}

function closeTrainingRulesModal() {
  $("trainingRulesModal")?.classList.add("hidden");
}

function openProposalCreateModal() {
  $("proposalCreateModal")?.classList.remove("hidden");
}

function closeProposalCreateModal() {
  $("proposalCreateModal")?.classList.add("hidden");
}

function openProposalModal() {
  $("proposalModal")?.classList.remove("hidden");
}

function closeProposalModal() {
  $("proposalModal")?.classList.add("hidden");
}

function openRulesModal() {
  $("rulesModal")?.classList.remove("hidden");
}

function closeRulesModal() {
  $("rulesModal")?.classList.add("hidden");
}

function showStatus() {
  return;
}

function shortHash(hash) {
  if (!hash || typeof hash !== "string" || hash.length < 12) return hash || "";
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

function removeToast(toast) {
  if (!toast || toast.dataset.removing === "1") return;
  toast.dataset.removing = "1";
  if (toast._timer) clearTimeout(toast._timer);
  const onRemove = toast._onRemove;
  toast._onRemove = null;
  if (typeof onRemove === "function") onRemove();
  if (toast.parentNode) toast.remove();
}

function trimToasts(container, maxToasts = 4) {
  while (container.children.length >= maxToasts) {
    removeToast(container.firstElementChild);
  }
}

function showToast(message, type = "info", duration = 3200, options = {}) {
  const container = $("toastContainer");
  if (!container) return null;

  const title = options.title || "";
  const dedupe = options.dedupe !== false;
  const key = `${type}|${title}|${message}`;
  const now = Date.now();
  if (dedupe && lastToastKey === key && now - lastToastAt < 1500) return null;
  lastToastKey = key;
  lastToastAt = now;

  trimToasts(container, options.maxToasts || 4);

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast._onRemove = typeof options.onClose === "function" ? options.onClose : null;

  const head = document.createElement("div");
  head.className = "toast-head";

  const titleEl = document.createElement("strong");
  titleEl.className = "toast-title";
  titleEl.textContent = title || (type === "error" ? "操作失败" : "系统提示");

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "toast-close";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => removeToast(toast));

  const body = document.createElement("div");
  body.className = "toast-message";
  body.textContent = message;

  head.appendChild(titleEl);
  head.appendChild(closeBtn);
  toast.appendChild(head);
  toast.appendChild(body);
  container.appendChild(toast);

  if (duration > 0) toast._timer = setTimeout(() => removeToast(toast), duration);
  return {
    toast,
    update(nextMessage, nextTitle) {
      if (typeof nextTitle === "string") titleEl.textContent = nextTitle;
      body.textContent = nextMessage;
    },
    close() {
      removeToast(toast);
    }
  };
}

function getErrorMessage(err) {
  const msg = err?.reason || err?.shortMessage || err?.message || String(err);
  if (msg.includes("duplicate call detected")) return "钱包里已有一笔相同请求待确认，请先去钱包处理后再重试。";
  if (msg.includes("User denied") || msg.includes("user rejected") || msg.includes("ACTION_REJECTED")) return "你已在钱包中取消本次操作";
  if (msg.includes("-32002") || msg.includes("already pending")) return "钱包正在处理上一笔请求，请先回到钱包完成确认后再重试。";
  if (msg.includes("insufficient funds")) return "钱包原生币余额不足，可能不够支付 Gas";
  if (msg.includes("No round")) return "该轮次不存在";
  if (msg.includes("Entered")) return "你本轮已经参与过了，每个地址每轮只能参与 1 次，请等待下一轮开始。";
  return msg;
}

async function submitTransaction(actionLabel, sendTx) {
  showToast(`请在钱包中确认 ${actionLabel}`, "info", 2800, { title: "等待钱包确认" });
  const walletHintTimer = setTimeout(() => {
    const env = detectWalletEnvironment();
    showToast(`如果钱包没有弹窗，请先检查${env.name || "当前钱包"}里的待确认请求。${getNetworkHelpText()}`, "warning", 7600, { title: "授权等待中", dedupe: false });
  }, 8000);
  try {
    const tx = await sendTx();
    const hash = shortHash(tx.hash);
    log(`${actionLabel}交易已发送: ${tx.hash}`);
    showToast(`交易哈希：${hash}`, "info", 4200, { title: `${actionLabel}已发送` });
    await tx.wait();
    clearTimeout(walletHintTimer);
    log(`${actionLabel}链上确认成功`);
    showToast(`交易哈希：${hash}`, "success", 4800, { title: `${actionLabel}已确认` });
    return tx;
  } catch (err) {
    clearTimeout(walletHintTimer);
    throw new Error(getErrorMessage(err));
  }
}

function fmt18(value) {
  try {
    const text = ethers.formatEther(value);
    const [intPart, decPart = ""] = text.split(".");
    const shortDec = decPart.slice(0, 5).replace(/0+$/, "");
    return shortDec ? `${intPart}.${shortDec}` : intPart;
  } catch {
    return String(value);
  }
}

function fmtUsdFromBnb18(value, rate = 660) {
  try {
    const bnb = Number(ethers.formatEther(value));
    if (!Number.isFinite(bnb)) return "0 USD";
    return `${Math.round(bnb * rate).toLocaleString("en-US")} USD`;
  } catch {
    return "0 USD";
  }
}

function fmtTime(ts) {
  const n = Number(ts || 0);
  return n > 0 ? new Date(n * 1000).toLocaleString("zh-CN") : "-";
}

function fmtNums(nums) {
  return Array.from(nums || []).filter(Boolean).join(", ") || "-";
}

function parseLegacyTrainingRecords(text = "") {
  return String(text).split("\n").map((line) => {
    const m = line.match(/轮次\s+(\d+)\s+\|\s+号码:\s*([^|]+)\|\s+中奖:\s*(是|否)\s+\|\s+状态:\s*(.+)$/);
    if (!m) return null;
    return { roundId: Number(m[1]), nums: m[2].split(",").map((n) => Number(n.trim())).filter(Boolean), winning: m[3] === "是", claimed: m[4].includes("已领"), forfeited: m[4].includes("作废") };
  }).filter(Boolean);
}

function renderTrainingRecords(records = [], pendingRewardText = "0 BNB", loadingText = "") {
  const box = $("myTrainingRecords");
  if (!box) return;
  const list = Array.isArray(records) ? records : [];
  if ($("trainingRecordsCount")) $("trainingRecordsCount").textContent = loadingText ? "-" : String(list.length);
  if ($("trainingRecordsWins")) $("trainingRecordsWins").textContent = loadingText ? "-" : String(list.filter((x) => x.winning).length);
  if ($("trainingRecordsPending")) $("trainingRecordsPending").textContent = loadingText ? "加载中" : pendingRewardText;
  if (loadingText) {
    box.className = "training-records-list empty";
    box.innerHTML = `<div class="training-record-empty">${loadingText}</div>`;
    return;
  }
  if (!list.length) {
    box.className = "training-records-list empty";
    box.innerHTML = '<div class="training-record-empty">暂无训练记录，完成参与后会在这里展示你的历史轮次、命中结果与领奖状态。</div>';
    return;
  }
  box.className = "training-records-list";
  box.innerHTML = list.map((item) => {
    const state = item.forfeited ? ["forfeit", "已作废"] : item.claimed ? ["claimed", "已领取"] : item.winning ? ["win", "待领取"] : ["miss", "未命中"];
    return `<article class="training-record-item"><div class="training-record-top"><span class="training-record-round">第 ${item.roundId} 轮</span><span class="training-record-pill ${state[0]}">${state[1]}</span></div><div class="training-record-nums">${(item.nums || []).map((n) => `<span class="training-record-ball">${n}</span>`).join("")}</div><div class="training-record-meta">${item.winning ? "本轮已命中开奖号码，可在奖励有效期内领取。" : "本轮未命中开奖号码，记录已保留。"}</div></article>`;
  }).join("");
}

function fmtDuration(sec) {
  const s = Math.max(0, Number(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}分${String(r).padStart(2, "0")}秒`;
}

function fmtLongDuration(sec) {
  const s = Math.max(0, Number(sec || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}天${h}小时${m}分钟`;
}

function getChainNowSec() {
  return Math.floor((Date.now() + chainTimeOffsetMs) / 1000);
}

async function syncChainTime() {
  const block = await provider.getBlock("latest");
  if (block?.timestamp) chainTimeOffsetMs = Number(block.timestamp) * 1000 - Date.now();
}

function updateEnterActionState(phase, cls, text) {
  if ($("enterStatusBadge")) {
    $("enterStatusBadge").className = `status-tag ${cls}`;
    $("enterStatusBadge").textContent = text;
  }
}

function setTrainingHint(text) {
  if ($("trainingHint")) $("trainingHint").textContent = text;
}

function syncEnterButtonState() {
  const enterBtn = $("enterBtn");
  if (!enterBtn) return;
  const disabled = trainingEligibilityState !== "eligible" || trainingEnteredCurrentRound;
  enterBtn.disabled = disabled;
  if (trainingEnteredCurrentRound) enterBtn.title = "你已参与本轮训练，请等待下一轮开始";
  else if (trainingEligibilityState === "ineligible") enterBtn.title = "当前持仓未达到参与门槛 500,000 代币";
  else enterBtn.title = "";
}

function setTrainingEligibilityState(state = "waiting") {
  const badge = $("trainingEligibilityBadge");
  const note = $("trainingEligibilityNote");
  trainingEligibilityState = state;
  if (badge) {
    badge.className = `status-tag training-eligibility-badge ${state}`;
    badge.textContent = state === "eligible" ? "已达标" : state === "ineligible" ? "未达标" : "等待读取";
  }
  if (note) {
    note.textContent = "参与和领奖门槛 ≥ 500,000 代币";
  }
  syncEnterButtonState();
}

async function refreshTrainingEligibility(roundId) {
  if (!vaultContract || !tokenContract || !account) {
    setTrainingEligibilityState("waiting");
    return false;
  }
  try {
    const [threshold, balance] = await Promise.all([
      vaultContract.getRoundMinPlayThreshold(roundId),
      tokenContract.balanceOf(account)
    ]);
    const fixedThreshold = ethers.parseUnits("500000", tokenDecimals);
    const eligible = balance >= threshold && balance >= fixedThreshold;
    setTrainingEligibilityState(eligible ? "eligible" : "ineligible");
    if (!eligible) {
      setTrainingHint(`当前持仓未达到第 ${roundId} 轮参与门槛，达标后才可参与训练。`);
    }
    return eligible;
  } catch {
    setTrainingEligibilityState("waiting");
    return false;
  }
}

function buildWelcomeTickerMarkup() {
  return '<span class="result-ticker-segment is-welcome"><span class="result-ticker-value">欢迎来到金靴球王</span></span>';
}

function buildTickerSegment(label, value, cls = "") {
  return `<span class="result-ticker-segment ${cls}"><span class="result-ticker-key">${label}</span><span class="result-ticker-value">${value}</span></span>`;
}

function buildTickerBalls(nums) {
  const values = Array.from(nums || []).filter(Boolean);
  if (!values.length) return '<span class="result-ticker-balls-empty">-</span>';
  return values.map((num) => `<span class="result-ticker-ball">${num}</span>`).join("");
}

function refreshTickerMotion() {
  const track = $("resultTickerTrack");
  const text = $("resultTickerText");
  const marquee = document.querySelector(".result-ticker-marquee");
  if (!track || !text || !marquee) return;
  requestAnimationFrame(() => {
    const trackWidth = Math.ceil(text.scrollWidth || 0);
    const marqueeWidth = Math.ceil(marquee.clientWidth || 0);
    const enterGap = 10;
    const exitGap = 10;
    const startX = marqueeWidth + enterGap;
    const endX = -(trackWidth + exitGap);
    const travel = startX - endX;
    const duration = Math.max(14, Math.min(26, travel / 64));
    track.style.setProperty("--ticker-duration", `${duration.toFixed(2)}s`);
    track.style.setProperty("--ticker-start-x", `${startX}px`);
    track.style.setProperty("--ticker-end-x", `${endX}px`);
  });
}

function setLatestResultTicker(markup = buildWelcomeTickerMarkup()) {
  const safeMarkup = markup || buildWelcomeTickerMarkup();
  const text = $("resultTickerText");
  if (!text) return;
  const changed = text.innerHTML !== safeMarkup;
  text.innerHTML = safeMarkup;
  refreshTickerMotion();
  if (changed) {
    text.classList.remove("ticker-refresh");
    void text.offsetWidth;
    text.classList.add("ticker-refresh");
  }
}

function buildLatestResultTickerText(roundId, result) {
  return [
    buildTickerSegment("轮次", roundId, "is-round"),
    `<span class="result-ticker-segment is-balls"><span class="result-ticker-key">开奖球员</span><span class="result-ticker-value result-ticker-balls">${buildTickerBalls(result[10])}</span></span>`,
    buildTickerSegment("最高命中", result[11], "is-hit"),
    buildTickerSegment("中奖人数", result[7], "is-wins")
  ].join("");
}

async function refreshLatestResultTicker(currentRoundValue) {
  if (!vaultContract) return setLatestResultTicker();
  try {
    const currentRound = Number(currentRoundValue || await vaultContract.curRound());
    const latestSettledRound = currentRound - 1;
    if (latestSettledRound < 1) return setLatestResultTicker();
    const result = await vaultContract.getRoundResult(latestSettledRound);
    if (!result[12]) return setLatestResultTicker();
    setLatestResultTicker(buildLatestResultTickerText(latestSettledRound, result));
  } catch {
    setLatestResultTicker();
  }
}

async function refreshTrainingParticipationHint(roundId) {
  if (!vaultContract || !account) {
    trainingEnteredCurrentRound = false;
    currentRoundTicketNums = [];
    renderCurrentRoundTicket();
    return;
  }
  try {
    const status = await vaultContract.getTicketStatus(roundId, account);
    trainingEnteredCurrentRound = !!status[0];
    if (status[0]) {
      const ticket = await vaultContract.getRoundTicket(roundId, account);
      currentRoundTicketNums = Array.from(ticket[1] || []).map(Number).filter(Boolean);
      renderCurrentRoundTicket(roundId, currentRoundTicketNums);
      setTrainingHint(`你已参与第 ${roundId} 轮，本轮不能重复参与，请等待下一轮开始。`);
    } else {
      currentRoundTicketNums = [];
      renderCurrentRoundTicket();
      setTrainingHint(`当前是第 ${roundId} 轮，每个地址每轮只能参与 1 次。`);
    }
    syncEnterButtonState();
  } catch {
    trainingEnteredCurrentRound = false;
    currentRoundTicketNums = [];
    renderCurrentRoundTicket();
    syncEnterButtonState();
    setTrainingHint("每个地址每轮只能参与 1 次");
  }
}

function renderRoundBoard(roundInfo) {
  if (!roundInfo || !$("roundPhase")) return;
  latestRoundInfo = roundInfo;
  const now = getChainNowSec();
  const closeAt = Number(roundInfo[2]);
  const endAt = Number(roundInfo[3]);
  const drawn = !!roundInfo[4];
  let phase = "待开奖", cls = "draw", countdown = "等待开奖", tip = "结束待开奖", action = "等待开奖";
  let countdownLabel = "下次开奖倒计时";
  let countdownNote = "统一链上结算";
  if (drawn) {
    phase = "已开奖"; cls = "done"; countdown = "本轮已开奖"; tip = "待下轮进入"; action = "已开奖";
    countdownLabel = "本轮已开奖";
    countdownNote = "等待进入下一轮";
  } else if (now <= closeAt) {
    phase = "报名中"; cls = "open"; countdown = `${fmtDuration(closeAt - now)}`; tip = "现可参与"; action = "可参与";
    countdownLabel = "下次开奖倒计时";
    countdownNote = "统一链上结算";
  } else if (now <= endAt) {
    phase = "封盘中"; cls = "locked"; countdown = `${fmtDuration(endAt - now)}`; tip = "30秒后开奖"; action = "已封盘";
    countdownLabel = "封盘中即将开奖";
    countdownNote = "已封盘，正在等待开奖";
  }
  
  // 更新状态大屏
  $("roundPhase").textContent = phase;
  $("roundCountdown").value = countdown;
  if ($("roundCountdownLabel")) $("roundCountdownLabel").textContent = countdownLabel;
  if ($("roundCountdownNote")) $("roundCountdownNote").textContent = countdownNote;
  
  // 更新轮次看板入口
  if ($("roundTips")) $("roundTips").value = tip;
  if ($("entryCloseAtText")) $("entryCloseAtText").value = fmtTime(closeAt);
  if ($("roundEndAtText")) $("roundEndAtText").value = fmtTime(endAt);
  
  updateEnterActionState(phase, cls, action);
  ensureRoundSyncFrequency(roundInfo);
}

function getRoundSyncInterval(roundInfo) {
  if (!roundInfo) return ROUND_SYNC_INTERVAL_NORMAL;
  const now = getChainNowSec();
  const closeAt = Number(roundInfo[2]);
  const endAt = Number(roundInfo[3]);
  const drawn = !!roundInfo[4];
  return !drawn && now > closeAt && now <= endAt ? ROUND_SYNC_INTERVAL_LOCKED : ROUND_SYNC_INTERVAL_NORMAL;
}

function ensureRoundSyncFrequency(roundInfo = latestRoundInfo) {
  const nextInterval = getRoundSyncInterval(roundInfo);
  if (roundSyncIntervalMs === nextInterval && roundSyncTimer) return;
  clearInterval(roundSyncTimer);
  roundSyncIntervalMs = nextInterval;
  roundSyncTimer = setInterval(() => {
    syncRoundStateFromChain();
  }, nextInterval);
}

async function syncRoundStateFromChain() {
  if (!vaultContract || roundSyncBusy) return;
  roundSyncBusy = true;
  try {
    const nextRoundInfo = await vaultContract.getCurrentRoundInfo();
    const prev = latestRoundInfo;
    latestRoundInfo = nextRoundInfo;
    renderRoundBoard(nextRoundInfo);

    if (!prev) return;
    const prevRoundId = Number(prev[0]);
    const nextRoundId = Number(nextRoundInfo[0]);
    const drawChanged = Boolean(prev[4]) !== Boolean(nextRoundInfo[4]);
    const roundChanged = prevRoundId !== nextRoundId;

    if (drawChanged || roundChanged) {
      const settledRoundId = roundChanged ? prevRoundId : nextRoundId;
      await loadVaultData();
      try {
        await fillRoundResultBox(settledRoundId);
      } catch (e) {
        log(`自动更新开奖结果失败: ${getErrorMessage(e)}`);
      }
      showToast(roundChanged ? `第 ${settledRoundId} 轮已开奖，当前进入第 ${nextRoundId} 轮` : `第 ${nextRoundId} 轮已开奖`, "info", 3200, { title: "轮次已更新", dedupe: false });
    }
  } catch (err) {
    log(`轮次自动同步失败: ${getErrorMessage(err)}`);
  } finally {
    roundSyncBusy = false;
  }
}

function startRoundClock(roundInfo) {
  clearInterval(roundClockTimer);
  clearInterval(roundSyncTimer);
  roundSyncIntervalMs = 0;
  renderRoundBoard(roundInfo);
  roundClockTimer = setInterval(() => renderRoundBoard(latestRoundInfo), 1000);
  ensureRoundSyncFrequency(roundInfo);
}

function buildClaimGuide(roundId, status, roundResult) {
  if (!status[0]) return "该轮没有参与";
  if (!roundResult[12]) return "尚未开奖";
  if (!status[1]) return `未中奖 (奖励 ${fmt18(roundResult[6])})`;
  if (status[3]) return `奖励已作废`;
  if (status[2]) return `已领取 ${fmt18(roundResult[6])}`;
  return `中奖! 可领 ${fmt18(roundResult[6])} BNB。截止：${fmtTime(roundResult[3])}`;
}

async function findUnclaimedRewards(limit = 12) {
  await initContracts();
  const currentRound = Number(await vaultContract.curRound());
  const winners = [];
  let totalReward = 0n;
  for (let rId = Math.max(1, currentRound - 1); rId >= Math.max(1, currentRound - limit); rId--) {
    const [status, roundResult] = await Promise.all([
      vaultContract.getTicketStatus(rId, account),
      vaultContract.getRoundResult(rId)
    ]);
    if (status[1] && !status[3]) {
      totalReward += roundResult[6];
    }
    if (status[1] && !status[2] && !status[3]) {
      winners.push({ roundId: rId, reward: roundResult[6], deadline: roundResult[3] });
    }
  }
  return { winners, totalReward };
}

async function findUnclaimedRewardsByRoundIds(roundIds = []) {
  await initContracts();
  const ids = [...new Set(roundIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => b - a);
  const winners = [];
  let totalReward = 0n;
  for (let i = 0; i < ids.length; i += TRAINING_RECORD_BATCH_SIZE) {
    const batchIds = ids.slice(i, i + TRAINING_RECORD_BATCH_SIZE);
    const batch = await Promise.all(batchIds.map(async (rId) => {
      const [status, roundResult] = await Promise.all([
        vaultContract.getTicketStatus(rId, account),
        vaultContract.getRoundResult(rId)
      ]);
      return { rId, status, roundResult };
    }));
    batch.forEach(({ rId, status, roundResult }) => {
      if (status[1] && !status[3]) totalReward += roundResult[6];
      if (status[1] && !status[2] && !status[3]) winners.push({ roundId: rId, reward: roundResult[6], deadline: roundResult[3] });
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return { winners, totalReward };
}

async function remindUnclaimedRewards(limit = 12) {
  const { winners, totalReward } = await findUnclaimedRewards(limit);
  
  setRewardSummaryText(`${fmt18(totalReward)} BNB`);
  setRewardSummaryState(winners.length ? "pending" : "ready", winners.length ? `${winners.length} 笔奖励待领取` : "当前没有待领取奖励");

  if (!winners.length) {
    lastClaimReminderKey = "";
    return;
  }

  const first = winners[0];
  if ($("claimRoundId")) $("claimRoundId").value = String(first.roundId);

  const reminderKey = winners.map((x) => `${x.roundId}:${x.reward}`).join("|");
  if (reminderKey !== lastClaimReminderKey) {
    lastClaimReminderKey = reminderKey;
    showToast(`你有 ${winners.length} 笔待领奖励，总额 ${fmt18(totalReward)} BNB`, "warning", 5000, { title: "待领提醒" });
  }
}

function getVaultAddress() {
  return $("vaultAddress").value.trim() || CONFIG.VAULT_ADDRESS;
}

function isPositiveInteger(value) {
  return /^\d+$/.test(String(value).trim()) && BigInt(String(value).trim()) > 0n;
}

function isValidAddress(value) {
  try {
    return ethers.isAddress(value);
  } catch {
    return false;
  }
}

function validateTrainingNumbers(n1, n2, n3) {
  const nums = [n1, n2, n3];
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 12)) {
    throw new Error("训练场号码必须是 1-12 的整数");
  }
  if (new Set(nums).size !== 3) {
    throw new Error("训练场号码不能重复");
  }
}

function syncPlayerSelectionUI() {
  const selected = [$("n1")?.value, $("n2")?.value, $("n3")?.value].filter(Boolean);
  const picker = $("playerPicker");
  picker?.classList.toggle("has-selection", selected.length > 0);
  document.querySelectorAll("#playerPicker .player-card").forEach((card) => {
    card.classList.toggle("selected", selected.includes(card.dataset.num));
  });
  if ($("playerSelectionText")) {
    $("playerSelectionText").textContent = selected.length ? `已选择：${selected.join("、")} 号球员` : "暂未选择球员";
  }
}

function bindPlayerPicker() {
  const picker = $("playerPicker");
  if (!picker) return;
  picker.addEventListener("click", (e) => {
    const card = e.target.closest(".player-card");
    if (!card) return;
    const num = card.dataset.num;
    let selected = [$("n1")?.value, $("n2")?.value, $("n3")?.value].filter(Boolean);
    if (selected.includes(num)) {
      selected = selected.filter((v) => v !== num);
    } else {
      if (selected.length >= 3) {
        showToast("最多只能选择 3 名球员", "warning");
        return;
      }
      selected.push(num);
      selected.sort((a, b) => Number(a) - Number(b));
    }
    [$("n1"), $("n2"), $("n3")].forEach((input, index) => {
      if (input) input.value = selected[index] || "";
    });
    syncPlayerSelectionUI();
  });
  syncPlayerSelectionUI();
}

async function ensureContractCode(address, label) {
  const code = await provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error(`${label}地址未部署：${address}`);
  }
}

async function refreshTokenState(tokenAddress) {
  const [decimals, symbol, balance] = await Promise.all([
    tokenContract.decimals(),
    tokenContract.symbol(),
    tokenContract.balanceOf(account)
  ]);

  tokenDecimals = Number(decimals);
  const balanceText = `${ethers.formatUnits(balance, tokenDecimals)} ${symbol}`;
  $("tokenAddress").value = tokenAddress;
  $("tokenBalance").value = balanceText;
  if ($("walletChipBalance")) $("walletChipBalance").textContent = ethers.formatUnits(balance, tokenDecimals).slice(0, 8);
  if ($("walletChipAddress")) $("walletChipAddress").textContent = shortAccount(account);
}

function getPreferredChainParams() {
  return {
    chainId: `0x${CONFIG.CHAIN_ID.toString(16)}`,
    chainName: CONFIG.CHAIN_NAME,
    nativeCurrency: { name: CONFIG.CURRENCY_SYMBOL, symbol: CONFIG.CURRENCY_SYMBOL, decimals: 18 },
    rpcUrls: [CONFIG.RPC_URL],
    blockExplorerUrls: [CONFIG.EXPLORER_URL]
  };
}

async function ensureCorrectNetwork(providerRef = provider) {
  if (!providerRef) throw new Error("钱包 Provider 未初始化");
  const network = await providerRef.getNetwork();
  if (Number(network.chainId) === CONFIG.CHAIN_ID) return;
  suppressResetUntil = Date.now() + 5000;
  const chainParams = getPreferredChainParams();
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainParams.chainId }]
    });
  } catch (switchErr) {
    if (switchErr?.code === 4902) {
      try {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [chainParams]
        });
      } catch (addErr) {
        if (addErr?.code === 4001) throw new Error(`你已取消添加网络。${getNetworkHelpText()}`);
        if (addErr?.code === -32002) throw new Error(`钱包正在处理网络请求，请先到钱包里确认。${getNetworkHelpText()}`);
        throw addErr;
      }
    } else if (switchErr?.code === 4001) {
      throw new Error(`你已取消切换网络。${getNetworkHelpText()}`);
    } else if (switchErr?.code === -32002) {
      throw new Error(`钱包正在处理网络切换请求，请先到钱包里确认。${getNetworkHelpText()}`);
    } else {
      throw new Error(`自动切换网络失败。${getNetworkHelpText()}`);
    }
  }
  const refreshedNetwork = await providerRef.getNetwork();
  if (Number(refreshedNetwork.chainId) !== CONFIG.CHAIN_ID) throw new Error(getNetworkHelpText());
}

function rememberAutoConnect(enabled = true) {
  try {
    if (enabled) localStorage.setItem(SESSION_KEYS.AUTO_CONNECT, "1");
    else localStorage.removeItem(SESSION_KEYS.AUTO_CONNECT);
  } catch {}
}

function resetWalletState(reason = "状态重置") {
  if ((reason === "网络切换" || reason === "账户切换") && Date.now() < suppressResetUntil) return;
  setLatestResultTicker();
  provider = undefined;
  signer = undefined;
  account = undefined;
  vaultContract = undefined;
  tokenContract = undefined;
  tokenDecimals = 18;
  latestRoundInfo = undefined;
  clearInterval(roundClockTimer);
  clearInterval(roundSyncTimer);

  setPill("walletInfo", "未连接", "warning");
  setPill("contractPill", "合约未检查", "muted");
  setWalletMenuConnected(false);
  closeWalletDropdown();
  if ($("walletChipBalance")) $("walletChipBalance").textContent = "--";
  if ($("walletChipAddress")) $("walletChipAddress").textContent = "0x----";
  updateWalletContextUI();

  const fields = ["accountAddress", "networkName", "tokenBalance", "roundPhase", "roundCountdown", "entryCloseAtText", "roundEndAtText", "roundTips"];
  fields.forEach(id => { if($(id)) $(id).value = $(id).textContent = "-"; });
  
  currentRoundTicketNums = [];
  renderCurrentRoundTicket();
  updateEnterActionState("waiting", "waiting", "请先读取金库数据");
  setTrainingEligibilityState("waiting");
  log(reason);
  showToast(reason, "warning");
}

function bindWalletEvents() {
  if (!window.ethereum || walletListenersBound) return;
  window.ethereum.on("accountsChanged", () => resetWalletState("账户切换"));
  window.ethereum.on("chainChanged", () => resetWalletState("网络切换"));
  walletListenersBound = true;
}

async function ensureConnected() {
  if (!window.ethereum) throw new Error(getWalletOpenHint());
  if (!provider || !signer || !account) await connectWallet();
  await ensureCorrectNetwork();
  return true;
}

async function connectWallet() {
  if (!window.ethereum) throw new Error(getWalletOpenHint());
  suppressResetUntil = Date.now() + 5000;
  await restoreAuthorizedSession(true);
  rememberAutoConnect(true);
  await loadVaultData();
  log(`钱包已连接并自动读取数据，页面推荐专用 RPC：${CONFIG.RPC_URL}`);
  showToast(`钱包连接成功。${getNetworkHelpText()}`, "success", 3600, { title: "连接成功" });
}

async function restoreAuthorizedSession(withPrompt = false) {
  if (!window.ethereum) throw new Error(getWalletOpenHint());
  bindWalletEvents();
  const nextProvider = new ethers.BrowserProvider(window.ethereum);
  const accounts = withPrompt
    ? await nextProvider.send("eth_requestAccounts", [])
    : await nextProvider.send("eth_accounts", []);
  if (!accounts?.length) return false;

  await ensureCorrectNetwork(nextProvider);
  const nextSigner = await nextProvider.getSigner();
  const network = await nextProvider.getNetwork();
  if (Number(network.chainId) !== CONFIG.CHAIN_ID) {
    resetWalletState(`请切到 ${CONFIG.CHAIN_NAME}`);
    throw new Error(`网络不正确`);
  }

  provider = nextProvider;
  signer = nextSigner;
  account = accounts[0];
  $("networkName").value = `${CONFIG.CHAIN_NAME}`;
  $("accountAddress").value = account;
  setPill("networkPill", CONFIG.CHAIN_NAME, "info");
  setPill("walletInfo", "已连接", "success");
  setWalletMenuConnected(true);
  if ($("walletChipAddress")) $("walletChipAddress").textContent = shortAccount(account);
  if (!$("vaultAddress").value) $("vaultAddress").value = CONFIG.VAULT_ADDRESS;
  rememberAutoConnect(true);
  return true;
}

async function initContracts() {
  await ensureConnected();
  const vaultAddress = getVaultAddress();
  if (!isValidAddress(vaultAddress)) throw new Error("地址不正确");
  await ensureContractCode(vaultAddress, "金库");
  vaultContract = new ethers.Contract(vaultAddress, VAULT_ABI, signer);

  let tokenAddress;
  try {
    tokenAddress = await vaultContract.taxToken();
  } catch {
    throw new Error(`读取 taxToken 失败`);
  }
  await ensureContractCode(tokenAddress, "主币");
  tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  await refreshTokenState(tokenAddress);
}

async function loadVaultData() {
  await initContracts();
  const [trainingPool, gloryPool, curRound, desc, activeBuybackToken, roundInfo] = await Promise.all([
    vaultContract.trainingPool(),
    vaultContract.gloryPool(),
    vaultContract.curRound(),
    vaultContract.description(),
    vaultContract.activeBuybackToken(),
    vaultContract.getCurrentRoundInfo()
  ]);

  $("trainingPool").innerText = `${fmt18(trainingPool)}`;
  $("gloryPool").innerText = `${fmt18(gloryPool)}`;
  if ($("trainingPoolUsd")) $("trainingPoolUsd").innerText = `≈ ${fmtUsdFromBnb18(trainingPool)}`;
  if ($("gloryPoolUsd")) $("gloryPoolUsd").innerText = `≈ ${fmtUsdFromBnb18(gloryPool)}`;
  $("curRound").innerText = String(curRound);
  if ($("vaultDescription")) $("vaultDescription").value = desc;
  if ($("buybackTargetEcho")) $("buybackTargetEcho").value = activeBuybackToken;
  setPill("contractPill", "合约正常", "success");

  await syncChainTime();
  startRoundClock(roundInfo);
  await refreshTrainingParticipationHint(Number(curRound));
  await refreshTrainingEligibility(Number(curRound));
  await refreshLatestResultTicker(Number(curRound));
  log("数据读取成功");
}

async function approveAmount(amount, options = {}) {
  await initContracts();
  const spender = await vaultContract.getAddress();
  await submitTransaction(options.actionLabel || "授权代币", () => tokenContract.approve(spender, amount));
  if (!options.skipReload) {
    await loadVaultData();
  }
}

async function approveTicket() {
  await initContracts();
  const amount = ethers.parseUnits("1000000", tokenDecimals);
  await approveAmount(amount);
}

async function approveVote() {
  await initContracts();
  const amount = ethers.parseUnits($("voteAmount").value || "0", tokenDecimals);
  if (amount <= 0n) throw new Error("请输入投票数量");
  await approveAmount(amount);
}

async function enterTrainingGround() {
  await initContracts();
  const n1 = Number($("n1").value);
  const n2 = Number($("n2").value);
  const n3 = Number($("n3").value);
  validateTrainingNumbers(n1, n2, n3);

  const currentRound = Number(await vaultContract.curRound());
  const eligible = await refreshTrainingEligibility(currentRound);
  if (!eligible) {
    throw new Error("当前持仓未达到本轮参与门槛，暂不可参与训练");
  }
  const currentStatus = await vaultContract.getTicketStatus(currentRound, account);
  if (currentStatus[0]) {
    setTrainingHint(`你已参与第 ${currentRound} 轮，本轮不能重复参与，请等待下一轮开始。`);
    throw new Error("你本轮已经参与过了，每个地址每轮只能参与 1 次，请等待下一轮开始。");
  }

  const spender = await vaultContract.getAddress();
  const ticketPrice = ethers.parseUnits("50000", tokenDecimals);
  const autoApproveAmount = ethers.parseUnits("1000000", tokenDecimals);
  const allowance = await tokenContract.allowance(account, spender);

  if (allowance < ticketPrice) {
    log(`训练场额度不足，先自动授权 1000000 枚主币，当前 allowance=${allowance}`);
    await submitTransaction("训练场自动授权", () => tokenContract.approve(spender, autoApproveAmount));
  }

  await submitTransaction("参与训练场", () => vaultContract.enterTrainingGround(n1, n2, n3));
  trainingEnteredCurrentRound = true;
  currentRoundTicketNums = [n1, n2, n3];
  renderCurrentRoundTicket(currentRound, currentRoundTicketNums);
  syncEnterButtonState();
  setActionPhase("enterBtn", "参与训练", "参与训练（自动授权）", "同步中");
  setTrainingHint(`你已参与第 ${currentRound} 轮，本轮不能重复参与，请等待下一轮开始。`);
  await loadVaultData();
}

async function drawCurrentRound() {
  await initContracts();
  await submitTransaction("开奖", () => vaultContract.drawCurrentRound());
  await loadVaultData();
}

async function claimReward() {
  await initContracts();
  const rId = Number($("claimRoundId").value);
  if (!rId) throw new Error("请输入领奖轮次");
  await submitTransaction("领取奖励", () => vaultContract.claimTrainingReward(rId));
  await loadVaultData();
}

async function sweepExpiredRound() {
  await initContracts();
  const rId = Number($("sweepRoundId").value);
  if (!rId) throw new Error("请输入回收轮次");
  await submitTransaction("回收过期奖励", () => vaultContract.sweepExpiredRound(rId));
  await loadVaultData();
}

async function claimAllRewards() {
  await initContracts();
  const progressToast = showToast("正在统计可领奖励...", "info", 0, { title: "一键领取进度", dedupe: false });
  let keepToastAlive = false;
  try {
    setActionPhase("claimAllBtn", "一键领取", "一键领取", "计算中");
    let winnerIds = getFreshPendingRewardRoundIds();
    if (!winnerIds.length) {
      progressToast?.update("正在统计可领奖励...", "一键领取进度");
      const { winners } = await findUnclaimedRewards(100);
      if (!winners.length) throw new Error("无待领奖励");
      winnerIds = winners.map((x) => Number(x.roundId));
    }
    setActionPhase("claimAllBtn", "一键领取", "一键领取", "领取确认中");
    progressToast?.update(`已找到 ${winnerIds.length} 笔可领奖励，等待钱包确认...`, "一键领取进度");
    await submitTransaction("一键领取", () => vaultContract.claimAllTrainingRewards(winnerIds.map((id) => BigInt(id))));
    applyClaimAllLocalRewardState();
    setActionPhase("claimAllBtn", "一键领取", "一键领取", "同步中");
    progressToast?.update("链上已确认，已先更新奖励状态，后台同步中...", "一键领取进度");
    keepToastAlive = true;
    Promise.allSettled([loadVaultData(), refreshTrainingRewardsSummary()]).finally(() => progressToast?.close());
  } finally {
    if (!keepToastAlive) progressToast?.close();
  }
}

async function queryTicketStatus() {
  await initContracts();
  const rId = Number($("ticketRoundId").value || $("claimRoundId").value);
  if (!rId) throw new Error("请输入查询轮次");
  const [status, result, ticket] = await Promise.all([
    vaultContract.getTicketStatus(rId, account),
    vaultContract.getRoundResult(rId),
    vaultContract.getRoundTicket(rId, account)
  ]);
  const text = `轮次 ${rId}\n号码: ${fmtNums(ticket[1])}\n中奖: ${status[1] ? "是" : "否"}\n已领取: ${status[2] ? "是" : "否"}\n已作废: ${status[3] ? "是" : "否"}\n命中数: ${status[4]}\n${buildClaimGuide(rId, status, result)}`;
  $("ticketStatusBox").value = text;
}

function renderHistoryQuickRounds(activeRound = 1, anchorRound = activeRound) {
  const box = $("historyQuickRounds");
  if (!box) return;
  const rounds = [];
  for (let i = 0; i < 6; i++) {
    const rId = Math.max(1, anchorRound - i);
    if (!rounds.includes(rId)) rounds.push(rId);
  }
  box.innerHTML = rounds.map((rId) => `<button class="history-round-chip ${rId === activeRound ? "active" : ""}" type="button" data-round-id="${rId}">第 ${rId} 轮</button>`).join("");
}

async function fillRoundResultBox(rId) {
  const result = await vaultContract.getRoundResult(rId);
  const payload = { roundId: rId, nums: Array.from(result[10] || []).map(Number), drawn: !!result[12], highMatch: Number(result[11]), winnerCount: Number(result[7]), rewardText: `${fmt18(result[6])} BNB`, deadlineText: fmtTime(result[3]) };
  if ($("roundResultId")) $("roundResultId").value = String(rId);
  renderHistoryQuickRounds(rId, Math.max(rId, Number($("roundResultId")?.value || rId)));
  renderRoundResultCard(payload);
  if (result[12]) setLatestResultTicker(buildLatestResultTickerText(rId, result));
  saveCache(CACHE_KEYS.ROUND_RESULT, { roundId: rId, payload });
}

async function queryRoundResultById(rId, options = {}) {
  await initContracts();
  if (!rId) throw new Error("请输入轮次");
  await fillRoundResultBox(rId);
  if (!options.silent) showToast(`已切换到第 ${rId} 轮开奖结果`, "success", 2200, { title: "历史开奖" });
}

async function queryRoundResult() {
  const rId = Number($("roundResultId").value);
  await queryRoundResultById(rId);
}

async function stepHistoryRound(delta) {
  const current = Number($("roundResultId")?.value || 1);
  const next = Math.max(1, current + delta);
  await queryRoundResultById(next);
}

async function refreshTrainingRewardsSummary() {
  await initContracts();
  const currentRound = Number(await vaultContract.curRound());
  const cache = loadCache(CACHE_KEYS.TRAINING_RECORDS);
  const recordMap = new Map(Array.isArray(cache?.records) ? cache.records.map((item) => [Number(item.roundId), item]) : []);
  const recentFloor = Math.max(1, currentRound - TRAINING_RECORD_RECENT_RESYNC + 1);

  await scanTrainingRecordsRange(currentRound, recentFloor, recordMap);

  const records = [...recordMap.entries()].sort((a, b) => b[0] - a[0]).map(([, item]) => item);
  if (!records.length) {
    setRewardSummaryText("0 BNB");
    setRewardSummaryState("idle", "参与训练后这里会汇总奖励");
    renderTrainingRecords([], "0 BNB");
    saveCache(CACHE_KEYS.TRAINING_RECORDS, { records: [], pendingRewardText: "0 BNB", pendingWinnerRoundIds: [], historyComplete: cache?.historyComplete === true, lastRound: currentRound });
    showToast("暂未发现你的训练记录，无法计算历史累计奖励。", "info", 3200, { title: "奖励已刷新" });
    return;
  }

  const { winners, totalReward } = await findUnclaimedRewardsByRoundIds(records.map((item) => item.roundId));
  const pendingRewardText = `${fmt18(totalReward)} BNB`;
  setRewardSummaryText(pendingRewardText);
  setRewardSummaryState(winners.length ? "pending" : "ready", winners.length ? `${winners.length} 笔奖励待领取` : `已累计参与 ${records.length} 轮训练`);
  renderTrainingRecords(records, pendingRewardText);
  saveCache(CACHE_KEYS.TRAINING_RECORDS, { records, pendingRewardText, pendingWinnerRoundIds: winners.map((item) => Number(item.roundId)), historyComplete: cache?.historyComplete === true, lastRound: currentRound });
  showToast(winners.length ? `已找到 ${winners.length} 笔可领奖励，当前待领取总额 ${pendingRewardText}` : "当前没有待领奖励", winners.length ? "success" : "info", 3200, { title: "奖励已刷新", dedupe: false });
  if (!winners.length) lastClaimReminderKey = "";
}

async function scanTrainingRecordsRange(startRound, endRound, recordMap, onProgress, controller) {
  if (startRound < endRound) return;
  const total = startRound - endRound + 1;
  let processed = 0;
  for (let start = startRound; start >= endRound; start -= TRAINING_RECORD_BATCH_SIZE) {
    if (controller?.cancelled) throw new Error("__USER_CANCELLED__");
    const end = Math.max(endRound, start - TRAINING_RECORD_BATCH_SIZE + 1);
    const jobs = [];
    for (let rId = start; rId >= end; rId--) {
      jobs.push((async () => {
        const [ticket, status] = await Promise.all([
          vaultContract.getRoundTicket(rId, account),
          vaultContract.getTicketStatus(rId, account)
        ]);
        if (!ticket[3]) return { roundId: rId, item: null };
        return { roundId: rId, item: { roundId: rId, nums: Array.from(ticket[1] || []).filter(Boolean), winning: !!status[1], claimed: !!ticket[2], forfeited: !!ticket[4] } };
      })());
    }
    const batch = await Promise.all(jobs);
    if (controller?.cancelled) throw new Error("__USER_CANCELLED__");
    batch.forEach(({ roundId, item }) => item ? recordMap.set(roundId, item) : recordMap.delete(roundId));
    processed += start - end + 1;
    if (typeof onProgress === "function") onProgress({ processed, total });
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

async function queryMyTrainingRecords() {
  await initContracts();
  openTrainingRecordsModal();
  const currentRound = Number(await vaultContract.curRound());
  const cache = loadCache(CACHE_KEYS.TRAINING_RECORDS);
  const recordMap = new Map(Array.isArray(cache?.records) ? cache.records.map((item) => [Number(item.roundId), item]) : []);
  const recentFloor = Math.max(1, currentRound - TRAINING_RECORD_RECENT_RESYNC + 1);
  const progressBtn = $("myRecordsBtn");
  const controller = { cancelled: false, done: false };
  trainingRecordsRefreshController = controller;
  const progressToast = showToast("正在读取最近训练记录（0/0）", "info", 0, {
    title: "训练记录刷新中",
    dedupe: false,
    onClose: () => {
      if (!controller.done) controller.cancelled = true;
    }
  });
  const setProgress = (phase, processed = 0, total = 0) => {
    const text = total > 0 ? `${phase}（${processed}/${total}）` : phase;
    renderTrainingRecords([], "0 BNB", text);
    progressToast?.update(text, "训练记录刷新中");
    if (progressBtn) setButtonLoadingState(progressBtn, true, "刷新我的训练记录", total > 0 ? `刷新中 ${processed}/${total}` : "刷新中");
  };

  try {
    setProgress("正在读取最近训练记录", 0, currentRound - recentFloor + 1);
    await scanTrainingRecordsRange(currentRound, recentFloor, recordMap, ({ processed, total }) => {
      setProgress("正在读取最近训练记录", processed, total);
    }, controller);
    if (!cache?.historyComplete) {
      setProgress("正在补齐更早训练记录", 0, recentFloor - 1);
      await scanTrainingRecordsRange(recentFloor - 1, 1, recordMap, ({ processed, total }) => {
        setProgress("正在补齐更早训练记录", processed, total);
      }, controller);
    }
    if (controller.cancelled) throw new Error("__USER_CANCELLED__");

    const records = [...recordMap.entries()].sort((a, b) => b[0] - a[0]).map(([, item]) => item);
    const { winners = [], totalReward } = records.length ? await findUnclaimedRewardsByRoundIds(records.map((item) => item.roundId)) : { winners: [], totalReward: 0n };
    if (controller.cancelled) throw new Error("__USER_CANCELLED__");
    const pendingRewardText = `${fmt18(totalReward)} BNB`;
    setRewardSummaryText(pendingRewardText);
    setRewardSummaryState(records.length ? (winners.length ? "pending" : "ready") : "idle", records.length ? (winners.length ? `${winners.length} 笔奖励待领取` : `已累计参与 ${records.length} 轮训练`) : "参与训练后这里会汇总奖励");
    renderTrainingRecords(records, pendingRewardText);
    saveCache(CACHE_KEYS.TRAINING_RECORDS, { records, pendingRewardText, pendingWinnerRoundIds: winners.map((item) => Number(item.roundId)), historyComplete: true, lastRound: currentRound });
    progressToast?.close();
  } finally {
    controller.done = true;
    if (trainingRecordsRefreshController === controller) trainingRecordsRefreshController = null;
  }
}

async function getTokenSymbolCached(address) {
  if (!address) return "UNKNOWN";
  if (tokenSymbolCache.has(address)) return tokenSymbolCache.get(address);
  try {
    const c = new ethers.Contract(address, ERC20_ABI, provider);
    const symbol = await c.symbol();
    tokenSymbolCache.set(address, symbol || "UNKNOWN");
  } catch {
    tokenSymbolCache.set(address, "UNKNOWN");
  }
  return tokenSymbolCache.get(address);
}

function renderProposalList(items = [], emptyText = "暂无提案记录", loading = false) {
  const box = $("proposalListBox");
  if (!box) return;
  if (!items.length) {
    box.className = "proposal-list empty";
    box.innerHTML = loading
      ? `<div class="proposal-loading"><span class="proposal-loading-spinner"></span><span>${emptyText}</span></div>`
      : `<div class="training-record-empty">${emptyText}</div>`;
    return;
  }
  box.className = "proposal-list";
  box.innerHTML = items.map((item) => `<article class="proposal-card"><div class="proposal-card-top"><div><strong class="proposal-card-title">#${item.id} · ${item.title}</strong><div class="proposal-card-subtitle">目标代币：${item.symbol}</div><div class="proposal-card-address-row"><div class="proposal-card-address">${item.fullTarget}</div><button class="proposal-copy-btn" type="button" data-copy-text="${item.fullTarget}">复制</button></div></div><span class="proposal-card-status ${item.statusClass}">${item.statusText}</span></div><div class="proposal-card-meta"><span>开始：${item.startAt}</span><span>结束：${item.endAt}</span><span class="proposal-countdown ${item.countdownClass}">提案倒计时：${item.countdownText}</span></div><div class="proposal-vote-strip"><div class="proposal-vote-head"><span>赞成 ${item.yesVotes}</span><span>反对 ${item.noVotes}</span></div><div class="proposal-vote-bar"><span class="proposal-vote-yes" style="width:${item.yesRatio}%"></span><span class="proposal-vote-no" style="width:${item.noRatio}%"></span></div></div><div class="proposal-lock-row"><span class="proposal-lock-badge ${item.lockClass}">我的锁仓：${item.lockText}</span><span class="proposal-lock-amount">我的质押：${item.myVoteAmount}</span></div><div class="proposal-card-actions"><input class="proposal-inline-amount" data-proposal-id="${item.id}" placeholder="输入质押数量" ${item.voteLocked ? "disabled" : ""} /><button class="mini-btn primary" data-proposal-action="yes" data-proposal-id="${item.id}" ${item.voteLocked ? "disabled" : ""}>支持</button><button class="mini-btn" data-proposal-action="no" data-proposal-id="${item.id}" ${item.voteLocked ? "disabled" : ""}>反对</button><button class="mini-btn" data-proposal-action="withdraw" data-proposal-id="${item.id}" ${item.canWithdraw ? "" : "disabled"}>取回质押</button></div></article>`).join("");
}

function openProposalModalFast() {
  openProposalModal();
  const cache = loadCache(CACHE_KEYS.PROPOSALS);
  if (Array.isArray(cache?.items) && cache.items.length) {
    renderProposalList(cache.items);
  } else {
    renderProposalList([], "正在读取提案记录...", true);
  }
  refreshProposalList(true).catch((err) => {
    showToast(`刷新提案失败：${err.message}`, "error");
  });
}

async function refreshProposalList(openedAlready = false) {
  if (proposalRefreshBusy) return;
  proposalRefreshBusy = true;
  try {
    await initContracts();
    if (!openedAlready) openProposalModal();
    const cache = loadCache(CACHE_KEYS.PROPOSALS);
    if (!openedAlready || !Array.isArray(cache?.items) || !cache.items.length) {
      renderProposalList([], "正在读取提案记录...", true);
    }
    const total = Number(await vaultContract.pCount());
    const items = [];
  for (let pId = total; pId >= 1; pId--) {
    const [p, myVote] = await Promise.all([vaultContract.getProposalInfo(pId), account ? vaultContract.getVoteInfo(pId, account) : [0n, false, false, 0n]]);
    const settled = !!p[6];
    const passed = !!p[7];
    const endAtSec = Number(p[3]);
    const nowSec = getChainNowSec();
    const remainingSec = Math.max(0, endAtSec - nowSec);
    const yesVotesNum = Number(fmt18(p[4])) || 0;
    const noVotesNum = Number(fmt18(p[5])) || 0;
    const totalVotesNum = yesVotesNum + noVotesNum;
    const lockUntilSec = Number(myVote[3] || 0);
    const unlockSec = Math.max(endAtSec, lockUntilSec);
    const hasVote = BigInt(myVote[0] || 0) > 0n;
    const canWithdraw = hasVote && !myVote[2] && nowSec >= unlockSec;
    const voteLocked = hasVote && !myVote[2];
    const lockText = !hasVote ? "未质押" : myVote[2] ? "已取回" : nowSec >= unlockSec ? "可取回" : fmtLongDuration(unlockSec - nowSec);
    const countdownText = settled || nowSec >= endAtSec ? "已结束" : fmtLongDuration(remainingSec);
    const countdownClass = settled || nowSec >= endAtSec ? "ended" : remainingSec <= 21600 ? "urgent" : remainingSec <= 86400 ? "soon" : "normal";
    items.push({ id: pId, title: p[0], fullTarget: p[1], symbol: await getTokenSymbolCached(p[1]), startAt: fmtTime(p[2]), endAt: fmtTime(p[3]), countdownText, countdownClass, yesVotes: fmt18(p[4]), noVotes: fmt18(p[5]), yesRatio: totalVotesNum > 0 ? ((yesVotesNum / totalVotesNum) * 100).toFixed(2) : 50, noRatio: totalVotesNum > 0 ? ((noVotesNum / totalVotesNum) * 100).toFixed(2) : 50, statusText: settled ? (passed ? "已通过" : "未通过") : "进行中", statusClass: settled ? (passed ? "passed" : "closed") : "open", lockText, lockClass: canWithdraw ? "ready" : (hasVote && !myVote[2] ? "locked" : "ended"), canWithdraw, voteLocked, myVoteAmount: hasVote ? fmt18(myVote[0]) : "0" });
  }
    renderProposalList(items);
    saveCache(CACHE_KEYS.PROPOSALS, { items });
  } finally {
    proposalRefreshBusy = false;
  }
}

async function createProposal() {
  await initContracts();
  const title = $("proposalTitle").value.trim();
  const target = $("proposalTarget").value.trim();
  if (!title) throw new Error("请输入提案标题");
  if (!target) throw new Error("请输入目标子币地址");
  await submitTransaction("创建提案", () => vaultContract.createProposal(target, title));
  closeProposalCreateModal();
  await loadVaultData();
  await refreshProposalList();
}

async function voteProposal() {
  await initContracts();
  const id = Number($("proposalId").value);
  if (!id) throw new Error("请输入提案ID");
  const amt = ethers.parseUnits($("voteAmount").value || "0", tokenDecimals);
  if (amt <= 0n) throw new Error("请输入投票数量");
  const side = $("voteSide").value === "true";
  await submitTransaction("投票", () => vaultContract.vote(id, amt, side));
  await loadVaultData();
}

async function ensureVoteAllowance(amount, actionLabel) {
  await initContracts();
  const spender = await vaultContract.getAddress();
  const allowance = await tokenContract.allowance(account, spender);
  if (allowance >= amount) return false;
  const approveAmountForVote = ethers.parseUnits("1000000", tokenDecimals);
  const finalApproveAmount = approveAmountForVote > amount ? approveAmountForVote : amount;
  pendingActionLabel = `${actionLabel}（授权中）`;
  showToast("检测到投票授权不足，先为你自动授权；授权确认后会自动继续投票。", "info", 3600, { title: "自动授权中" });
  await approveAmount(finalApproveAmount, { skipReload: true, actionLabel: "授权投票" });
  return true;
}

async function handleProposalCardAction(button) {
  const proposalId = Number(button.dataset.proposalId);
  const action = button.dataset.proposalAction;
  const amountInput = document.querySelector(`.proposal-inline-amount[data-proposal-id="${proposalId}"]`);
  const amountText = amountInput?.value?.trim() || "0";
  if (!proposalId) throw new Error("提案ID无效");
  if (action === "withdraw") {
    pendingActionLabel = "取回质押";
    await initContracts();
    await submitTransaction("取回质押", () => vaultContract.withdrawVote(proposalId));
    await refreshProposalList();
    return;
  }
  const amount = ethers.parseUnits(amountText, tokenDecimals);
  if (amount <= 0n) throw new Error("请输入质押数量");
  const actionLabel = action === "yes" ? "支持提案" : "反对提案";
  await ensureVoteAllowance(amount, actionLabel);
  pendingActionLabel = `${actionLabel}（提交中）`;
  await initContracts();
  await submitTransaction(actionLabel, () => vaultContract.vote(proposalId, amount, action === "yes"));
  await syncAfterAction(actionLabel, [loadVaultData(), refreshProposalList(true)], { toastMessage: "链上已确认，正在刷新提案进度与我的投票状态..." });
}

async function settleProposal() {
  await initContracts();
  const id = Number($("proposalId").value);
  if (!id) throw new Error("请输入提案ID");
  await submitTransaction("结算提案", () => vaultContract.settleProposal(id));
  await syncAfterAction("结算提案", [loadVaultData(), refreshProposalList(true)], { buttonId: "settleBtn", idleText: "结算" });
}

async function withdrawVote() {
  await initContracts();
  const id = Number($("proposalId").value);
  if (!id) throw new Error("请输入提案ID");
  await submitTransaction("取回投票", () => vaultContract.withdrawVote(id));
  await syncAfterAction("取回投票", [loadVaultData(), refreshProposalList(true)], { buttonId: "withdrawVoteBtn", idleText: "取回" });
}

async function executeBuyback() {
  await initContracts();
  const min = BigInt($("minOutputAmount").value || 0);
  const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [min]);
  await submitTransaction("买回", () => vaultContract["executeBuyback(bytes)"](data));
  await loadVaultData();
}

async function disconnectDapp() {
  suppressResetUntil = Date.now() + 4000;
  try {
    await window.ethereum?.request({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }]
    });
  } catch {}
  rememberAutoConnect(false);
  resetWalletState("已断开 DApp");
}

function bindEvents() {
  const b = [
    ["connectBtn", connectWallet, "连接"],
    ["loadBtn", loadVaultData, "读取"],
    ["approveTicketBtn", approveTicket, "授权"],
    ["drawBtn", drawCurrentRound, "开奖"],
    ["claimBtn", claimReward, "领奖"],
    ["sweepBtn", sweepExpiredRound, "回收"],
    ["ticketBtn", queryTicketStatus, "查票"],
    ["roundResultBtn", queryRoundResult, "查开奖"],
    ["proposalListBtn", refreshProposalList, "刷提案"],
    ["proposalListModalBtn", refreshProposalList, "刷新提案记录"],
    ["createProposalBtn", createProposal, "建提案"],
    ["approveVoteBtn", approveVote, "授权投票"],
    ["voteBtn", voteProposal, "投票"],
    ["settleBtn", settleProposal, "结算"],
    ["withdrawVoteBtn", withdrawVote, "取回"],
    ["buybackBtn", executeBuyback, "买回"]
  ];
  b.forEach(([id, fn]) => {
    const el = $(id);
    if(el) el.addEventListener("click", () => run(fn, el));
  });

  $("refreshRewardsBtn")?.addEventListener("click", () => {
    const btn = $("refreshRewardsBtn");
    run(refreshTrainingRewardsSummary, btn, {
      actionLabel: "刷新奖励",
      idleText: "刷新奖励",
      busyText: "刷新中",
      restoreDisabled: () => false
    });
  });

  $("claimAllBtn")?.addEventListener("click", () => {
    const btn = $("claimAllBtn");
    run(claimAllRewards, btn, {
      actionLabel: "一键领取",
      idleText: "一键领取",
      busyText: "计算中",
      restoreDisabled: () => !$("trainingRewardStatus")?.classList.contains("pending")
    });
  });

  $("enterBtn")?.addEventListener("click", () => {
    const btn = $("enterBtn");
    run(enterTrainingGround, btn, {
      actionLabel: "参与训练",
      idleText: "参与训练（自动授权）",
      busyText: "提交中",
      restoreDisabled: () => trainingEligibilityState !== "eligible" || trainingEnteredCurrentRound
    });
  });

  $("myRecordsBtn")?.addEventListener("click", () => {
    const btn = $("myRecordsBtn");
    run(queryMyTrainingRecords, btn, {
      actionLabel: "刷新我的训练记录",
      idleText: "刷新我的训练记录",
      busyText: "刷新中",
      restoreDisabled: () => false
    });
  });

  $("walletMenuBtn")?.addEventListener("click", () => {
    $("walletDropdown")?.classList.toggle("hidden");
  });
  $("copyAddressBtn")?.addEventListener("click", async () => {
    if (!account) return;
    await navigator.clipboard.writeText(account);
    closeWalletDropdown();
    showToast("地址已复制", "success");
  });
  $("openExplorerBtn")?.addEventListener("click", () => {
    if (!account) return;
    window.open(`${CONFIG.EXPLORER_URL}/address/${account}`, "_blank");
    closeWalletDropdown();
  });
  $("disconnectBtn")?.addEventListener("click", () => run(disconnectDapp, $("disconnectBtn")));
  $("openTrainingRecordsBtn")?.addEventListener("click", openTrainingRecordsModal);
  $("openTrainingRecordsBtnAlt")?.addEventListener("click", openTrainingRecordsModal);
  $("closeTrainingRecordsBtn")?.addEventListener("click", closeTrainingRecordsModal);
  $("trainingRecordsBackdrop")?.addEventListener("click", closeTrainingRecordsModal);
  $("openHistoryModalBtn")?.addEventListener("click", () => { openHistoryModal(); });
  $("closeHistoryModalBtn")?.addEventListener("click", closeHistoryModal);
  $("historyModalBackdrop")?.addEventListener("click", closeHistoryModal);
  $("historyPrevRoundBtn")?.addEventListener("click", () => { stepHistoryRound(-1); });
  $("historyNextRoundBtn")?.addEventListener("click", () => { stepHistoryRound(1); });
  $("historyQuickRounds")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-round-id]");
    if (!btn) return;
    queryRoundResultById(Number(btn.dataset.roundId));
  });
  $("openProposalCreateModalBtn")?.addEventListener("click", openProposalCreateModal);
  $("closeProposalCreateModalBtn")?.addEventListener("click", closeProposalCreateModal);
  $("proposalCreateModalBackdrop")?.addEventListener("click", closeProposalCreateModal);
  $("openProposalModalBtn")?.addEventListener("click", openProposalModalFast);
  $("closeProposalModalBtn")?.addEventListener("click", closeProposalModal);
  $("proposalModalBackdrop")?.addEventListener("click", closeProposalModal);
  $("proposalListBox")?.addEventListener("click", async (e) => {
    const copyBtn = e.target.closest("[data-copy-text]");
    if (copyBtn) {
      await navigator.clipboard.writeText(copyBtn.dataset.copyText || "");
      showToast("代币地址已复制", "success");
      return;
    }
    const btn = e.target.closest("[data-proposal-action]");
    if (!btn) return;
    run(() => handleProposalCardAction(btn), btn);
  });
  $("openRulesModalBtn")?.addEventListener("click", openRulesModal);
  $("closeRulesModalBtn")?.addEventListener("click", closeRulesModal);
  $("rulesModalBackdrop")?.addEventListener("click", closeRulesModal);
  $("openTrainingRulesBtn")?.addEventListener("click", openTrainingRulesModal);
  $("closeTrainingRulesBtn")?.addEventListener("click", closeTrainingRulesModal);
  $("trainingRulesModalBackdrop")?.addEventListener("click", closeTrainingRulesModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeTrainingRecordsModal();
      closeHistoryModal();
      closeProposalCreateModal();
      closeProposalModal();
      closeRulesModal();
      closeTrainingRulesModal();
    }
  });
  document.addEventListener("click", (e) => {
    const wrap = $("walletMenuWrap");
    if (wrap && !wrap.contains(e.target)) closeWalletDropdown();
  });
}

async function run(fn, button, options = {}) {
  const actionLabel = options.actionLabel || button?.textContent?.replace(/\s+/g, " ").trim() || fn?.name || "当前操作";
  if (pendingAction) {
    return showToast(`已有操作进行中：${pendingActionLabel || "请稍候"}。如果钱包没有弹窗，请先检查钱包待确认请求。`, "warning", 4200, { title: "操作未完成" });
  }
  pendingAction = true;
  pendingActionLabel = actionLabel;
  if (button) {
    button.disabled = true;
    if (options.idleText && options.busyText) setButtonLoadingState(button, true, options.idleText, options.busyText);
  }
  try {
    await fn();
    showToast(`${actionLabel}成功`, "success");
  } catch (err) {
    if (err?.message === "__USER_CANCELLED__") showToast(`${actionLabel}已取消`, "info", 2200, { title: "已取消", dedupe: false });
    else showToast(`${actionLabel}失败：${err.message}`, "error");
  } finally {
    pendingAction = false;
    pendingActionLabel = "";
    if (button) {
      if (options.idleText && options.busyText) setButtonLoadingState(button, false, options.idleText, options.busyText);
      button.disabled = typeof options.restoreDisabled === "function" ? !!options.restoreDisabled(button) : false;
    }
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  if($("tokenAddress")) $("tokenAddress").value = CONFIG.TOKEN_ADDRESS;
  if($("vaultAddress")) $("vaultAddress").value = CONFIG.VAULT_ADDRESS;
  updateWalletContextUI();
  bindEvents();
  bindPlayerPicker();
  restoreCachedPanels();
  refreshTickerMotion();
  window.addEventListener("resize", refreshTickerMotion);

  try {
    const shouldAutoConnect = localStorage.getItem(SESSION_KEYS.AUTO_CONNECT) === "1";
    if (!shouldAutoConnect) return;
    const restored = await restoreAuthorizedSession(false);
    if (restored) {
      await loadVaultData();
      log("已自动恢复连接并读取最新数据");
    }
  } catch (err) {
    log(`自动恢复失败: ${getErrorMessage(err)}`);
  }
});