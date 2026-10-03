import { createRoot } from "react-dom/client";
import { loadLang } from "../lang";
import { HistoryApp } from "./HistoryApp";

void loadLang().then(() => createRoot(document.getElementById("root")!).render(<HistoryApp />));
