import React from "react";
import { usePageStore } from "../store/usePageStore";

const Header: React.FC = () => {
  const { pageTitle } = usePageStore();

  return (
    <header className="header">
      <h1 className="header__title">{pageTitle}</h1>
    </header>
  );
};

export default Header;
