import React, { useEffect } from "react";
import Header from "./components/Header";
import Sidebar from "./components/Sidebar";
import { usePageStore } from "./store/usePageStore";
import "./AppLayout.css";

interface AppLayoutProps {
  title?: string;
  activePath?: string;
  children: React.ReactNode;
  rightPanel?: React.ReactNode;
  bottomPanel?: React.ReactNode;
}

const AppLayout: React.FC<AppLayoutProps> = ({
  title = "Dashboard",
  activePath = "/",
  children,
  rightPanel,
  bottomPanel,
}) => {
  const {
    sidebarOpen,
    bottomPanelOpen,
    rightPanelOpen,
    setPageTitle,
    setUser,
    toggleBottomPanel,
    toggleRightPanel,
  } = usePageStore();

  useEffect(() => {
    setPageTitle(title);
    setUser({ name: "César Pajuelo", email: "cesar.pajuelo01@gmail.com" });
  }, [title, setPageTitle, setUser]);

  return (
    <div className={`layout ${sidebarOpen ? "layout--sidebar-open" : "layout--sidebar-closed"}`}>
      <Sidebar activePath={activePath} />

      <div className="layout__body">
        <Header />

        <div className="layout__workspace">
          <div className="layout__viewport">
            <main className="layout__content">
              {children}
            </main>

            {bottomPanel && (
              <div className={`layout__bottom-panel ${bottomPanelOpen ? "layout__bottom-panel--open" : "layout__bottom-panel--closed"}`}>
                <button
                  className="panel-toggle-btn panel-toggle-btn--bottom"
                  onClick={toggleBottomPanel}
                  aria-label={bottomPanelOpen ? "Minimizar panel inferior" : "Expandir panel inferior"}
                >
                  {bottomPanelOpen ? "v" : "^"}
                </button>
                <div className="layout__bottom-panel-inner">
                  {bottomPanel}
                </div>
              </div>
            )}
          </div>

          {rightPanel && (
            <div className={`layout__right-panel ${rightPanelOpen ? "layout__right-panel--open" : "layout__right-panel--closed"}`}>
              <button
                className="panel-toggle-btn panel-toggle-btn--right"
                onClick={toggleRightPanel}
                aria-label={rightPanelOpen ? "Minimizar panel derecho" : "Expandir panel derecho"}
              >
                {rightPanelOpen ? ">" : "<"}
              </button>
              <div className="layout__right-panel-inner">
                {rightPanel}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AppLayout;
