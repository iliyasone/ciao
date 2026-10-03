import { createRoot } from "react-dom/client";
import { loadLang } from "../lang";
import { Overlay } from "./Overlay";

void loadLang().then(() => createRoot(document.getElementById("root")!).render(<Overlay />));
