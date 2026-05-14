import type { Trader } from "../types";

export function exportTraders(traders: Trader[]) {
  const headers = ["Address", "Label", "Enabled", "Created at"];
  const rows = traders.map((trader) => [
    trader.address,
    trader.label || "",
    trader.enabled === false ? "No" : "Yes",
    trader.createdAt
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, "\"\"")}"`).join(","))
    .join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "tracked-traders.csv";
  link.click();
  URL.revokeObjectURL(url);
}
