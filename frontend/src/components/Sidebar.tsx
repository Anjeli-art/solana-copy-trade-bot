import { Activity, BarChart3, Bot, ClipboardList, Radio, Wallet } from "lucide-react";
import type { View } from "../types";

type SidebarProps = {
  activeView: View;
  onViewChange: (view: View) => void;
};

export function Sidebar({ activeView, onViewChange }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <Bot size={24} />
        <span>Copy Bot</span>
      </div>
      <nav className="nav-list">
        <button
          className={`nav-item ${activeView === "dashboard" ? "active" : ""}`}
          type="button"
          onClick={() => onViewChange("dashboard")}
        >
          <Activity size={18} />
          Dashboard
        </button>
        <button
          className={`nav-item ${activeView === "positions" ? "active" : ""}`}
          type="button"
          onClick={() => onViewChange("positions")}
        >
          <Wallet size={18} />
          Positions
        </button>
        <button
          className={`nav-item ${activeView === "traders" ? "active" : ""}`}
          type="button"
          onClick={() => onViewChange("traders")}
        >
          <Radio size={18} />
          Traders
        </button>
        <button
          className={`nav-item ${activeView === "analytics" ? "active" : ""}`}
          type="button"
          onClick={() => onViewChange("analytics")}
        >
          <BarChart3 size={18} />
          Analytics
        </button>
        <button
          className={`nav-item ${activeView === "logs" ? "active" : ""}`}
          type="button"
          onClick={() => onViewChange("logs")}
        >
          <ClipboardList size={18} />
          Logs
        </button>
      </nav>
    </aside>
  );
}
