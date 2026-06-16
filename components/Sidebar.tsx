import React, { useEffect } from "react";
import { usePageStore } from "../store/usePageStore";
import { useHotspotStore } from "../store/useHotspotStore";
import UmapPanel from "./UmapPanel";
import CandidateList from "./CandidateList";

interface SidebarProps {
  /** Optional active route — accepted for layout symmetry; not used yet. */
  activePath?: string;
}

const Sidebar: React.FC<SidebarProps> = () => {
  const { sidebarOpen, toggleSidebar } = usePageStore();
  const { selectedItem } = useHotspotStore();

  // Auto-open sidebar when a hotspot is selected
  useEffect(() => {
    if (selectedItem && !sidebarOpen) {
      toggleSidebar();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItem]);

  return (
    <aside className={`sidebar ${sidebarOpen ? "sidebar--open" : "sidebar--closed"}`}>
      <div className="sidebar__inner">
        {/* Logo */}
        <div className="sidebar__logo">
          <span className="sidebar__logo-icon">🗺️</span>
          {sidebarOpen && <span className="sidebar__logo-text">Crime Map</span>}
        </div>

        {/* UMAP embedding of all subgraphs */}
        {sidebarOpen && <UmapPanel />}

        {/* Draggable pool: reference + similar subgraphs, or the lasso set */}
        {sidebarOpen && <CandidateList />}
      </div>

      <button
        className="sidebar__toggle-btn"
        onClick={toggleSidebar}
        aria-label={sidebarOpen ? "Minimizar sidebar" : "Expandir sidebar"}
      >
        {sidebarOpen ? "<" : ">"}
      </button>
    </aside>
  );
};

export default Sidebar;
