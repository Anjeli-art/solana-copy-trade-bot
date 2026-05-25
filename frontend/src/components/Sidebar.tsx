import type { MouseEvent } from "react";
import { Activity, BarChart3, Bot, ClipboardList, GitFork, Radio, Wallet } from "lucide-react";
import type { View } from "../types";
import { getRouteForView } from "../utils/routes";

type SidebarProps = {
  activeView: View;
  onViewChange: (view: View) => void;
};

const navItems = [
  { view: "dashboard", label: "Dashboard", icon: Activity },
  { view: "positions", label: "Positions", icon: Wallet },
  { view: "traders", label: "Traders", icon: Radio },
  { view: "mirror", label: "Mirror", icon: GitFork },
  { view: "analytics", label: "Analytics", icon: BarChart3 },
  { view: "logs", label: "Logs", icon: ClipboardList }
] satisfies Array<{ view: View; label: string; icon: typeof Activity }>;

export function Sidebar({ activeView, onViewChange }: SidebarProps) {
  function handleNavClick(event: MouseEvent<HTMLAnchorElement>, view: View) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    event.preventDefault();
    onViewChange(view);
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <Bot size={24} />
        <span>Copy Bot</span>
      </div>
      <nav className="nav-list">
        {navItems.map(({ view, label, icon: Icon }) => (
          <a
            aria-current={activeView === view ? "page" : undefined}
            className={`nav-item ${activeView === view ? "active" : ""}`}
            href={getRouteForView(view)}
            key={view}
            onClick={(event) => handleNavClick(event, view)}
          >
            <Icon size={18} />
            {label}
          </a>
        ))}
      </nav>
    </aside>
  );
}
