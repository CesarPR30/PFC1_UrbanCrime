import { create } from "zustand";

interface PageState {
  sidebarOpen: boolean;
  bottomPanelOpen: boolean;
  rightPanelOpen: boolean;
  pageTitle: string;
  user: { name: string; email: string } | null;
  toggleSidebar: () => void;
  toggleBottomPanel: () => void;
  toggleRightPanel: () => void;
  setPageTitle: (title: string) => void;
  setUser: (user: { name: string; email: string } | null) => void;
}

export const usePageStore = create<PageState>((set) => ({
  sidebarOpen: true,
  bottomPanelOpen: true,
  rightPanelOpen: true,
  pageTitle: "Dashboard",
  user: null,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  toggleBottomPanel: () => set((state) => ({ bottomPanelOpen: !state.bottomPanelOpen })),
  toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
  setPageTitle: (title) => set({ pageTitle: title }),
  setUser: (user) => set({ user }),
}));
