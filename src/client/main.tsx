import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { syncNow } from "./lib";
import "./style.css";
syncNow().then(() => createRoot(document.getElementById("root")!).render(<App />));
