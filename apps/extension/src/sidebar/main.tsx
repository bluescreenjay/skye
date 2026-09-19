import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "./Sidebar";
import "./sidebar.css";

const root = document.getElementById("root");
if (!root) throw new Error("Side Panel page is missing #root");

createRoot(root).render(
  <StrictMode>
    <Sidebar />
  </StrictMode>,
);
