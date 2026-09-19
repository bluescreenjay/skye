import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Home } from "./Home";
import "./home.css";

const root = document.getElementById("root");
if (!root) throw new Error("Home page is missing #root");

createRoot(root).render(
  <StrictMode>
    <Home />
  </StrictMode>,
);
