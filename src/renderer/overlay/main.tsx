import { createRoot } from "react-dom/client";
import { loadLang } from "../lang";
import { Overlay } from "./Overlay";

// Not awaited: the overlay must subscribe to "wake:enable" and capture events before the page's
// load event, and it is hidden until the first dictation anyway.
void loadLang();
createRoot(document.getElementById("root")!).render(<Overlay />);
