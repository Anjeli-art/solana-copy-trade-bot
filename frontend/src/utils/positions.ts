import type { ClosedFilter, ClosedPosition, Position } from "../types";

export function getPnl(position: Pick<Position, "entryPrice" | "currentPrice" | "amountUsd">) {
  const pnlPercent = ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100;
  const currentValue = position.amountUsd * (position.currentPrice / position.entryPrice);
  return {
    pnlPercent,
    pnlUsd: currentValue - position.amountUsd
  };
}

export function getClosedPnlUsd(position: ClosedPosition, solPriceUsd: number) {
  if (position.sellActualSolChange !== undefined && position.buyActualSolChange !== undefined && solPriceUsd > 0) {
    const spentSol = Math.abs(position.buyActualSolChange);
    const netSol = position.sellActualSolChange + position.buyActualSolChange;
    return {
      pnlPercent: spentSol > 0 ? (netSol / spentSol) * 100 : 0,
      pnlUsd: netSol * solPriceUsd
    };
  }

  return getPnl({
    ...position,
    currentPrice: position.exitPrice
  });
}

export function filterClosedPositions(
  positions: ClosedPosition[],
  filter: ClosedFilter,
  customFrom: string,
  customTo: string
) {
  if (filter === "all") return positions;

  if (filter === "custom") {
    const from = customFrom ? new Date(`${customFrom}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
    const to = customTo ? new Date(`${customTo}T23:59:59`).getTime() : Number.POSITIVE_INFINITY;
    return positions.filter((position) => {
      const closedAt = new Date(position.closedAt).getTime();
      return closedAt >= from && closedAt <= to;
    });
  }

  if (filter === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return positions.filter((position) => new Date(position.closedAt).getTime() >= start.getTime());
  }

  const days = filter === "week" ? 7 : 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return positions.filter((position) => new Date(position.closedAt).getTime() >= cutoff);
}

export function exportClosedPositions(positions: ClosedPosition[], solPriceUsd = 0) {
  const headers = [
    "Token",
    "Mint",
    "Buy platform",
    "Sell platform",
    "Entry price",
    "Exit price",
    "Amount USD",
    "Token amount",
    "Buy network fee SOL",
    "Buy priority fee SOL",
    "Buy quoted out amount",
    "Buy actual SOL change",
    "Sell network fee SOL",
    "Sell priority fee SOL",
    "Sell quoted out SOL",
    "Sell actual SOL change",
    "PnL %",
    "PnL USD",
    "Close reason",
    "Trader",
    "Opened at",
    "Closed at",
    "Sell tx"
  ];

  const rows = positions.map((position) => {
    const { pnlPercent, pnlUsd } = getClosedPnlUsd(position, solPriceUsd);

    return [
      position.tokenSymbol,
      position.tokenMint,
      position.platform,
      position.exitPlatform,
      position.entryPrice,
      position.exitPrice,
      position.amountUsd,
      position.tokenAmount,
      position.buyNetworkFeeSol ?? "",
      position.buyPriorityFeeSol ?? "",
      position.buyQuotedOutAmount ?? "",
      position.buyActualSolChange ?? "",
      position.sellNetworkFeeSol ?? "",
      position.sellPriorityFeeSol ?? "",
      position.sellQuotedOutSol ?? "",
      position.sellActualSolChange ?? "",
      pnlPercent.toFixed(2),
      pnlUsd.toFixed(2),
      position.closeReason,
      position.trader,
      position.openedAt,
      position.closedAt,
      position.sellTx
    ];
  });

  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, "\"\"")}"`).join(","))
    .join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "closed-positions.csv";
  link.click();
  URL.revokeObjectURL(url);
}
